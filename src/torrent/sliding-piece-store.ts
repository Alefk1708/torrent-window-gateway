import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TorrentLike } from './webtorrent-types.js'

type ErrorCallback = (error?: Error | null) => void
type GetCallback = (error: Error | null, data?: Uint8Array) => void

export interface StoreEntry {
  index: number
  size: number
  createdAt: number
  lastAccessAt: number
  tombstoned: boolean
}

interface StoreOptions {
  path: string
  torrent: TorrentLike
}

export const storeForTorrent = new WeakMap<object, SlidingPieceStore>()

/**
 * An abstract-chunk-store implementation that persists every verified torrent
 * piece in a separate file. Separate files make individual eviction possible;
 * a normal fs-chunk-store cannot safely punch arbitrary verified pieces out.
 */
export class SlidingPieceStore {
  readonly chunkLength: number
  readonly directory: string
  private readonly ready: Promise<void>
  private readonly entries = new Map<number, StoreEntry>()
  private readonly tombstones = new Set<number>()
  private readonly writes = new Map<number, Promise<void>>()
  private closed = false
  private byteCount = 0

  constructor(chunkLength: number, options: StoreOptions) {
    if (!Number.isSafeInteger(chunkLength) || chunkLength <= 0) {
      throw new Error('Invalid torrent piece length')
    }
    this.chunkLength = chunkLength
    this.directory = path.join(options.path, 'pieces')
    this.ready = mkdir(this.directory, { recursive: true }).then(() => undefined)
    storeForTorrent.set(options.torrent, this)
  }

  get residentBytes(): number {
    return this.byteCount
  }

  get residentPieces(): number {
    return this.entries.size
  }

  has(index: number): boolean {
    return this.entries.has(index) && !this.tombstones.has(index)
  }

  snapshot(): StoreEntry[] {
    return [...this.entries.values()].map((entry) => ({
      ...entry,
      tombstoned: this.tombstones.has(entry.index),
    }))
  }

  touch(index: number): void {
    const entry = this.entries.get(index)
    if (entry !== undefined) entry.lastAccessAt = Date.now()
  }

  put(index: number, data: Uint8Array, callback: ErrorCallback): void {
    if (this.closed) {
      queueMicrotask(() => callback(new Error('Chunk store is closed')))
      return
    }
    if (!Number.isSafeInteger(index) || index < 0) {
      queueMicrotask(() => callback(new Error('Invalid piece index')))
      return
    }

    const previous = this.writes.get(index) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      await this.ready
      if (this.closed) throw new Error('Chunk store is closed')

      const buffer = Buffer.from(data)
      const finalPath = this.piecePath(index)
      const temporaryPath = `${finalPath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, buffer, { flag: 'wx' })
      try {
        await rename(temporaryPath, finalPath)
      } catch (error) {
        await rm(temporaryPath, { force: true })
        throw error
      }

      const now = Date.now()
      const old = this.entries.get(index)
      if (old !== undefined) this.byteCount -= old.size
      this.entries.set(index, {
        index,
        size: buffer.byteLength,
        createdAt: now,
        lastAccessAt: now,
        tombstoned: false,
      })
      this.byteCount += buffer.byteLength
      this.tombstones.delete(index)
    })

    this.writes.set(index, task)
    void task.then(
      () => callback(null),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    ).finally(() => {
      if (this.writes.get(index) === task) this.writes.delete(index)
    })
  }

  get(
    index: number,
    options: { offset?: number; length?: number } | GetCallback,
    callback?: GetCallback,
  ): void {
    const getCallback = typeof options === 'function' ? options : callback
    const readOptions = typeof options === 'function' ? {} : options
    if (getCallback === undefined) throw new Error('A callback is required')

    void this.read(index, readOptions).then(
      (data) => getCallback(null, data),
      (error: unknown) => getCallback(error instanceof Error ? error : new Error(String(error))),
    )
  }

  beginEviction(index: number): void {
    this.tombstones.add(index)
  }

  async evict(index: number): Promise<boolean> {
    this.tombstones.add(index)
    await this.ready
    const pendingWrite = this.writes.get(index)
    if (pendingWrite !== undefined) await pendingWrite.catch(() => undefined)

    const entry = this.entries.get(index)
    if (entry === undefined) return false
    try {
      await unlink(this.piecePath(index))
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error
    }
    this.entries.delete(index)
    this.byteCount = Math.max(0, this.byteCount - entry.size)
    return true
  }

  close(callback: ErrorCallback): void {
    this.closed = true
    void Promise.allSettled([...this.writes.values()]).then(() => callback(null), (error: unknown) => {
      callback(error instanceof Error ? error : new Error(String(error)))
    })
  }

  destroy(callback: ErrorCallback): void {
    this.closed = true
    void Promise.allSettled([...this.writes.values()])
      .then(() => rm(this.directory, { recursive: true, force: true }))
      .then(() => {
        this.entries.clear()
        this.tombstones.clear()
        this.byteCount = 0
        callback(null)
      }, (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))))
  }

  private async read(index: number, options: { offset?: number; length?: number }): Promise<Buffer> {
    await this.ready
    if (this.closed) throw new Error('Chunk store is closed')
    if (this.tombstones.has(index)) throw missingPiece(index)
    const entry = this.entries.get(index)
    if (entry === undefined) throw missingPiece(index)

    const offset = options.offset ?? 0
    const length = options.length ?? entry.size - offset
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > entry.size) {
      throw new RangeError(`Invalid read bounds for piece ${index}`)
    }

    const handle = await open(this.piecePath(index), 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      let total = 0
      while (total < length) {
        const result = await handle.read(buffer, total, length - total, offset + total)
        if (result.bytesRead === 0) throw new Error(`Unexpected end of piece ${index}`)
        total += result.bytesRead
      }
      entry.lastAccessAt = Date.now()
      return buffer
    } finally {
      await handle.close()
    }
  }

  private piecePath(index: number): string {
    return path.join(this.directory, `${index.toString(16).padStart(8, '0')}.piece`)
  }
}

function missingPiece(index: number): NodeJS.ErrnoException {
  const error = new Error(`Piece ${index} is not resident`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
