import { EventEmitter } from 'node:events'
import type { AppConfig } from '../config.js'
import { HttpError, asError } from '../errors.js'
import { mediaInfo } from '../streaming/media-type.js'
import { SlidingPieceStore, storeForTorrent, type StoreEntry } from './sliding-piece-store.js'
import { WindowCoordinator, type PieceRange } from './window-coordinator.js'
import type { TorrentFileLike, TorrentLike } from './webtorrent-types.js'

export type TorrentSessionState = 'resolving_metadata' | 'metadata' | 'ready' | 'error' | 'deleting'

interface PieceWaiter {
  resolve(): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
}

export interface LoggerLike {
  debug(data: unknown, message?: string): void
  info(data: unknown, message?: string): void
  warn(data: unknown, message?: string): void
  error(data: unknown, message?: string): void
}

export class TorrentSession extends EventEmitter {
  readonly id: string
  readonly infoHash: string
  readonly torrent: TorrentLike
  readonly createdAt = Date.now()
  readonly windows = new WindowCoordinator(1)
  state: TorrentSessionState = 'resolving_metadata'
  lastAccessAt = Date.now()
  metadataReceivedAt: number | null = null
  errorMessage: string | null = null
  lastWarning: string | null = null
  playbackCount = 0
  activeStreams = 0

  private store: SlidingPieceStore | null = null
  private readonly waiters = new Map<number, Set<PieceWaiter>>()
  private readonly metadataTimer: NodeJS.Timeout
  private selectionTimer: NodeJS.Timeout | null = null
  private destroyed = false

  constructor(
    id: string,
    infoHash: string,
    torrent: TorrentLike,
    private readonly config: AppConfig,
    private readonly logger: LoggerLike,
  ) {
    super()
    this.id = id
    this.torrent = torrent
    this.infoHash = infoHash.toLowerCase()

    this.metadataTimer = setTimeout(() => {
      this.fail(new Error('Timed out while resolving torrent metadata'))
    }, config.metadataTimeoutMs)
    this.metadataTimer.unref()

    torrent.once('metadata', () => this.onMetadata())
    torrent.once('ready', () => this.onReady())
    torrent.on('verified', (index: number) => this.resolvePiece(index))
    torrent.on('warning', (error: unknown) => {
      this.lastWarning = asError(error).message
      this.logger.warn({ sessionId: this.id, warning: this.lastWarning }, 'Torrent warning')
    })
    torrent.on('error', (error: unknown) => this.fail(asError(error)))
  }

  get cacheBytes(): number {
    return this.store?.residentBytes ?? 0
  }

  get cachePieces(): number {
    return this.store?.residentPieces ?? 0
  }

  get isUsable(): boolean {
    return this.state === 'ready' && !this.destroyed && !this.torrent.destroyed
  }

  touch(): void {
    this.lastAccessAt = Date.now()
  }

  file(fileId: number): TorrentFileLike {
    if (!Number.isInteger(fileId) || fileId < 0) {
      throw new HttpError(400, 'INVALID_FILE_ID', 'fileId must be a non-negative integer')
    }
    const file = this.torrent.files[fileId]
    if (file === undefined) throw new HttpError(404, 'FILE_NOT_FOUND', 'Torrent file not found')
    return file
  }

  requireStreamableFile(fileId: number): TorrentFileLike {
    const file = this.file(fileId)
    if (!mediaInfo(file.name).streamable) {
      throw new HttpError(415, 'UNSUPPORTED_FILE_TYPE', 'This gateway only exposes media and subtitle files')
    }
    return file
  }

  setWindow(id: string, cursor: number, file: TorrentFileLike): void {
    const fileEnd = Math.max(file.offset, file.offset + file.length - 1)
    this.windows.set(
      id,
      cursor,
      file.offset,
      fileEnd,
      this.config.windowAheadBytes,
      this.config.windowBehindBytes,
    )
    this.touch()
    this.scheduleSelectionRefresh()
  }

  deleteWindow(id: string): void {
    this.windows.delete(id)
    this.scheduleSelectionRefresh()
  }

  protectedRanges(): PieceRange[] {
    if (!this.torrent.pieceLength || !this.torrent.pieces) return []
    return this.windows.ranges(this.torrent.pieceLength, this.torrent.pieces.length)
  }

  isPieceProtected(index: number): boolean {
    return this.protectedRanges().some((range) => index >= range.from && index <= range.to)
  }

  cacheEntries(): StoreEntry[] {
    return this.store?.snapshot() ?? []
  }

  async waitForPiece(index: number, signal?: AbortSignal): Promise<void> {
    this.assertReady()
    if (this.torrent.bitfield.get(index)) return
    if (index < 0 || index >= this.torrent.pieces.length) {
      throw new HttpError(416, 'INVALID_PIECE', 'Requested piece is outside the torrent')
    }
    if (signal?.aborted === true) throw abortedError()

    this.refreshSelectionsNow()
    this.torrent.critical(index, Math.min(index + 1, this.torrent.pieces.length - 1))

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(index, waiter)
        reject(new HttpError(504, 'PIECE_TIMEOUT', `Timed out waiting for torrent piece ${index}`))
      }, this.config.pieceTimeoutMs)
      timer.unref()
      const onAbort = signal === undefined ? undefined : () => {
        this.removeWaiter(index, waiter)
        reject(abortedError())
      }
      const waiter: PieceWaiter = { resolve, reject, timer, signal, onAbort }
      const set = this.waiters.get(index) ?? new Set<PieceWaiter>()
      set.add(waiter)
      this.waiters.set(index, set)
      if (onAbort !== undefined) signal?.addEventListener('abort', onAbort, { once: true })

      // Close the tiny race between the first bitfield check and waiter setup.
      if (this.torrent.bitfield.get(index)) this.resolvePiece(index)
    })
  }

  async readPiece(index: number, offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.waitForPiece(index, signal)
      try {
        return await new Promise<Buffer>((resolve, reject) => {
          this.torrent.store.get(index, { offset, length }, (error, data) => {
            if (error !== null) reject(error)
            else resolve(Buffer.from(data ?? []))
          })
        })
      } catch (error) {
        if (!hasCode(error, 'ENOENT') || attempt === 1) throw error
        await this.markMissing(index)
      }
    }
    throw new Error(`Could not read piece ${index}`)
  }

  async evictPiece(index: number): Promise<boolean> {
    if (this.store === null || this.isPieceProtected(index)) return false
    this.store.beginEviction(index)
    if (this.torrent.bitfield.get(index)) {
      this.torrent._markUnverified(index)
      this.notifyDontHave(index)
      this.torrent._checkDone?.()
    }
    return await this.store.evict(index)
  }

  refreshSelectionsNow(): void {
    if (!this.isUsable) return
    if (typeof this.torrent._selections?.clear !== 'function' || typeof this.torrent._updateSelections !== 'function') {
      this.fail(new Error('The pinned WebTorrent selection API is unavailable'))
      return
    }

    this.torrent._selections.clear()
    this.torrent._updateSelections()
    for (const range of this.protectedRanges()) {
      this.torrent.select(range.from, range.to, 10)
    }
    for (const piece of this.windows.criticalPieces(this.torrent.pieceLength, this.torrent.pieces.length)) {
      this.torrent.critical(piece, Math.min(piece + 1, this.torrent.pieces.length - 1))
    }
  }

  toJSON(): Record<string, unknown> {
    const files = this.torrent.files.map((file, id) => {
      const media = mediaInfo(file.name)
      return {
        id,
        name: file.name,
        path: file.path,
        size: file.length,
        contentType: media.contentType,
        streamable: media.streamable,
        browserCompatible: media.browserCompatible,
      }
    })
    return {
      id: this.id,
      infoHash: this.infoHash,
      name: this.torrent.name ?? null,
      state: this.state,
      error: this.errorMessage,
      warning: this.lastWarning,
      createdAt: new Date(this.createdAt).toISOString(),
      lastAccessAt: new Date(this.lastAccessAt).toISOString(),
      metadataReceivedAt: this.metadataReceivedAt === null ? null : new Date(this.metadataReceivedAt).toISOString(),
      size: this.torrent.length || null,
      pieceLength: this.torrent.pieceLength || null,
      pieceCount: this.torrent.pieces?.length ?? null,
      peers: this.torrent.numPeers || 0,
      downloadSpeed: this.torrent.downloadSpeed || 0,
      uploadSpeed: this.torrent.uploadSpeed || 0,
      receivedBytes: this.torrent.received || 0,
      uploadedBytes: this.torrent.uploaded || 0,
      residentBytes: this.torrent.downloaded || 0,
      cacheBytes: this.cacheBytes,
      cachePieces: this.cachePieces,
      playbackCount: this.playbackCount,
      activeStreams: this.activeStreams,
      activeWindows: this.windows.size,
      protectedPieceRanges: this.protectedRanges(),
      files,
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    this.state = 'deleting'
    clearTimeout(this.metadataTimer)
    if (this.selectionTimer !== null) clearTimeout(this.selectionTimer)
    this.windows.clear()
    this.rejectAllWaiters(new Error('Torrent session was removed'))

    if (!this.torrent.destroyed) {
      await new Promise<void>((resolve) => {
        this.torrent.destroy({ destroyStore: true }, (error) => {
          if (error) this.logger.warn({ sessionId: this.id, error: error.message }, 'Torrent cleanup warning')
          resolve()
        })
      })
    }
  }

  private onMetadata(): void {
    clearTimeout(this.metadataTimer)
    this.metadataReceivedAt = Date.now()
    this.store = storeForTorrent.get(this.torrent) ?? null

    try {
      if (this.torrent.length > this.config.maxTorrentBytes) {
        throw new Error('Torrent exceeds MAX_TORRENT_SIZE_GB')
      }
      if (this.torrent.files.length > this.config.maxTorrentFiles) {
        throw new Error('Torrent exceeds MAX_TORRENT_FILES')
      }
      if (this.torrent.pieces.length > this.config.maxTorrentPieces) {
        throw new Error('Torrent exceeds MAX_TORRENT_PIECES')
      }
      if (this.store === null || typeof this.torrent._markUnverified !== 'function') {
        throw new Error('Sliding piece store could not be attached')
      }
    } catch (error) {
      this.fail(asError(error))
      return
    }

    this.state = 'metadata'
    this.emit('metadata')
  }

  private onReady(): void {
    if (this.state === 'error' || this.destroyed) return
    this.store = storeForTorrent.get(this.torrent) ?? this.store
    this.state = 'ready'
    this.touch()
    this.refreshSelectionsNow()
    this.emit('ready')
  }

  private fail(error: Error): void {
    if (this.state === 'error' || this.destroyed) return
    clearTimeout(this.metadataTimer)
    this.state = 'error'
    this.errorMessage = error.message
    this.rejectAllWaiters(error)
    this.logger.error({ sessionId: this.id, error: error.message }, 'Torrent session failed')
    this.emit('sessionError', error)
    if (!this.torrent.destroyed) {
      this.torrent.destroy({ destroyStore: true }, () => undefined)
    }
  }

  private assertReady(): void {
    if (this.state === 'error') {
      throw new HttpError(409, 'TORRENT_ERROR', this.errorMessage ?? 'Torrent session failed')
    }
    if (!this.isUsable) {
      throw new HttpError(409, 'TORRENT_NOT_READY', 'Torrent metadata/store is not ready yet')
    }
  }

  private scheduleSelectionRefresh(): void {
    if (this.selectionTimer !== null) return
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null
      this.refreshSelectionsNow()
    }, 100)
    this.selectionTimer.unref()
  }

  private async markMissing(index: number): Promise<void> {
    this.store?.beginEviction(index)
    if (this.torrent.bitfield.get(index)) {
      this.torrent._markUnverified(index)
      this.notifyDontHave(index)
      this.torrent._checkDone?.()
    }
    await this.store?.evict(index)
    this.refreshSelectionsNow()
  }

  private notifyDontHave(index: number): void {
    for (const wire of this.torrent.wires) {
      if (wire.destroyed !== true) wire.lt_donthave?.donthave(index)
    }
  }

  private resolvePiece(index: number): void {
    const set = this.waiters.get(index)
    if (set === undefined) return
    this.waiters.delete(index)
    for (const waiter of set) {
      clearTimeout(waiter.timer)
      if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
    }
  }

  private removeWaiter(index: number, waiter: PieceWaiter): void {
    const set = this.waiters.get(index)
    if (set === undefined) return
    set.delete(waiter)
    clearTimeout(waiter.timer)
    if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener('abort', waiter.onAbort)
    if (set.size === 0) this.waiters.delete(index)
  }

  private rejectAllWaiters(error: Error): void {
    for (const set of this.waiters.values()) {
      for (const waiter of set) {
        clearTimeout(waiter.timer)
        if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.reject(error)
      }
    }
    this.waiters.clear()
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function abortedError(): Error {
  const error = new Error('Stream request was aborted')
  error.name = 'AbortError'
  return error
}
