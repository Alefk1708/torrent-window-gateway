import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebTorrent from 'webtorrent'
import type { AppConfig } from '../config.js'
import { HttpError } from '../errors.js'
import { constantTimeEqual, randomToken, tokenDigest } from '../security/credentials.js'
import { isBlockedPeerAddress, parseAndSanitizeTorrent } from '../security/tracker-sanitizer.js'
import { SlidingPieceStore } from './sliding-piece-store.js'
import { TorrentSession, type LoggerLike } from './torrent-session.js'
import type { TorrentFileLike, TorrentLike } from './webtorrent-types.js'

export interface PlaybackRecord {
  id: string
  torrentId: string
  fileId: number
  tokenHash: string
  clientIp: string
  createdAt: number
  lastSeenAt: number
  currentTime: number | null
  duration: number | null
  paused: boolean
  activeStreams: number
}

export interface PlaybackHeartbeat {
  currentTime?: number
  duration?: number
  paused?: boolean
}

export class TorrentManager {
  private readonly client: any
  private readonly sessions = new Map<string, TorrentSession>()
  private readonly byInfoHash = new Map<string, string>()
  private readonly playbacks = new Map<string, PlaybackRecord>()
  private readonly maintenanceTimer: NodeJS.Timeout
  private maintenanceRunning = false
  private totalActiveStreams = 0
  private closed = false
  private clientError: string | null = null

  constructor(
    readonly config: AppConfig,
    private readonly logger: LoggerLike,
  ) {
    this.client = new WebTorrent({
      maxConns: config.maxPeerConnections,
      tracker: true,
      dht: true,
      lsd: false,
      utPex: true,
      natUpnp: false,
      natPmp: false,
      webSeeds: config.allowWebSeeds,
      utp: false,
      seedOutgoingConnections: false,
      downloadLimit: config.downloadLimitBytesPerSecond,
      // A zero-byte WebTorrent throttle also blocks protocol handshakes. Data
      // seeding is disabled with per-torrent upload slots instead.
      uploadLimit: config.uploadLimitBytesPerSecond === 0 ? -1 : config.uploadLimitBytesPerSecond,
    })
    if (!config.allowPrivateNetworks) {
      // WebTorrent consults this object for outbound and inbound peer
      // addresses. This closes the direct-peer SSRF path in addition to the
      // tracker/webseed URL checks performed before a torrent is added.
      this.client.blocked = { contains: (address: string) => isBlockedPeerAddress(address) }
    }
    this.client.on('error', (error: Error) => {
      this.clientError = error.message
      this.logger.error({ error: error.message }, 'WebTorrent client error')
    })

    this.maintenanceTimer = setInterval(() => void this.maintenance(), config.gcIntervalMs)
    this.maintenanceTimer.unref()
  }

  async initialize(): Promise<void> {
    assertSafeCacheDirectory(this.config.cacheDir)
    await rm(this.config.cacheDir, { recursive: true, force: true })
    await mkdir(this.config.cacheDir, { recursive: true })
  }

  get isOperational(): boolean {
    return !this.closed && this.clientError === null && this.client.destroyed !== true
  }

  async addTorrent(input: string | Uint8Array): Promise<{ session: TorrentSession; reused: boolean }> {
    if (!this.isOperational) throw new HttpError(503, 'TORRENT_ENGINE_UNAVAILABLE', 'The torrent engine is unavailable')
    const parsed = await parseAndSanitizeTorrent(input, this.config)
    const infoHash = String(parsed.infoHash).toLowerCase()
    const existingId = this.byInfoHash.get(infoHash)
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId)
      if (existing !== undefined) {
        existing.touch()
        return { session: existing, reused: true }
      }
      this.byInfoHash.delete(infoHash)
    }

    await this.removeExpiredErrorSessions()
    if (this.sessions.size >= this.config.maxTorrents) {
      throw new HttpError(429, 'TORRENT_LIMIT_REACHED', `At most ${this.config.maxTorrents} torrent sessions may exist`)
    }

    const id = randomUUID()
    const sessionPath = path.join(this.config.cacheDir, id)
    const torrent = this.client.add(parsed, {
      path: sessionPath,
      store: SlidingPieceStore,
      storeCacheSlots: 0,
      destroyStoreOnDestroy: true,
      deselect: true,
      strategy: 'sequential',
      uploads: this.config.uploadSlots === 0 ? false : this.config.uploadSlots,
      alwaysChokeSeeders: true,
    }) as TorrentLike
    const session = new TorrentSession(id, infoHash, torrent, this.config, this.logger)
    this.sessions.set(id, session)
    this.byInfoHash.set(infoHash, id)
    this.logger.info({ sessionId: id, infoHash }, 'Torrent session created')
    return { session, reused: false }
  }

  getSession(id: string): TorrentSession {
    const session = this.sessions.get(id)
    if (session === undefined) throw new HttpError(404, 'TORRENT_NOT_FOUND', 'Torrent session not found')
    session.touch()
    return session
  }

  listSessions(): TorrentSession[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  async removeTorrent(id: string, force = false): Promise<void> {
    const session = this.getSession(id)
    const related = [...this.playbacks.values()].filter((playback) => playback.torrentId === id)
    if (!force && (related.length > 0 || session.activeStreams > 0)) {
      throw new HttpError(409, 'TORRENT_IN_USE', 'Torrent has active playbacks or streams; use force=true to remove it')
    }
    for (const playback of related) this.deletePlaybackInternal(playback)
    this.sessions.delete(id)
    this.byInfoHash.delete(session.infoHash)
    await session.destroy()
    await rm(path.join(this.config.cacheDir, id), { recursive: true, force: true })
    this.logger.info({ sessionId: id }, 'Torrent session removed')
  }

  createPlayback(torrentId: string, fileId: number, clientIp: string): { playback: PlaybackRecord; token: string } {
    const session = this.getSession(torrentId)
    if (!session.isUsable) throw new HttpError(409, 'TORRENT_NOT_READY', 'Wait until the torrent state is ready')
    const file = session.requireStreamableFile(fileId)
    this.expirePlaybacks()
    if (this.playbacks.size >= this.config.maxPlaybacks) {
      throw new HttpError(429, 'PLAYBACK_LIMIT_REACHED', `At most ${this.config.maxPlaybacks} playback sessions may exist`)
    }
    const forIp = [...this.playbacks.values()].filter((playback) => playback.clientIp === clientIp).length
    if (forIp >= this.config.maxPlaybacksPerIp) {
      throw new HttpError(429, 'IP_PLAYBACK_LIMIT_REACHED', 'This client has too many active playback sessions')
    }

    const id = randomUUID()
    const token = randomToken()
    const now = Date.now()
    const playback: PlaybackRecord = {
      id,
      torrentId,
      fileId,
      tokenHash: tokenDigest(token),
      clientIp,
      createdAt: now,
      lastSeenAt: now,
      currentTime: null,
      duration: null,
      paused: true,
      activeStreams: 0,
    }
    this.playbacks.set(id, playback)
    session.playbackCount += 1
    session.setWindow(playbackWindowId(id), file.offset, file)
    return { playback, token }
  }

  listPlaybacks(): PlaybackRecord[] {
    this.expirePlaybacks()
    return [...this.playbacks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  getPlaybackAdmin(id: string): PlaybackRecord {
    const playback = this.playbacks.get(id)
    if (playback === undefined) throw new HttpError(404, 'PLAYBACK_NOT_FOUND', 'Playback session not found')
    return playback
  }

  authorizePlayback(id: string, token: string, clientIp: string, touch = true): PlaybackRecord {
    const playback = this.playbacks.get(id)
    if (playback === undefined || token === '' || !constantTimeEqual(playback.tokenHash, tokenDigest(token))) {
      throw new HttpError(401, 'INVALID_PLAYBACK_TOKEN', 'Playback token is missing or invalid')
    }
    if (this.config.bindPlaybackToIp && playback.clientIp !== clientIp) {
      throw new HttpError(403, 'PLAYBACK_IP_MISMATCH', 'Playback token is bound to a different client address')
    }
    if (this.playbackExpiresAt(playback) <= Date.now() && playback.activeStreams === 0) {
      this.deletePlaybackInternal(playback)
      throw new HttpError(410, 'PLAYBACK_EXPIRED', 'Playback session expired')
    }
    if (touch) this.touchPlayback(playback)
    return playback
  }

  updatePlayback(playback: PlaybackRecord, heartbeat: PlaybackHeartbeat): PlaybackRecord {
    const currentTime = heartbeat.currentTime
    const duration = heartbeat.duration
    if (currentTime !== undefined && (!Number.isFinite(currentTime) || currentTime < 0)) {
      throw new HttpError(400, 'INVALID_CURRENT_TIME', 'currentTime must be a non-negative number')
    }
    if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) {
      throw new HttpError(400, 'INVALID_DURATION', 'duration must be a positive number')
    }
    if (currentTime !== undefined) playback.currentTime = currentTime
    if (duration !== undefined) playback.duration = duration
    if (heartbeat.paused !== undefined) playback.paused = Boolean(heartbeat.paused)
    this.touchPlayback(playback)

    const session = this.getSession(playback.torrentId)
    const file = session.file(playback.fileId)
    const cursor = estimatedCursor(file, playback.currentTime, playback.duration)
    session.setWindow(playbackWindowId(playback.id), cursor, file)
    return playback
  }

  deletePlayback(id: string, token: string, clientIp: string): void {
    const playback = this.authorizePlayback(id, token, clientIp, false)
    if (playback.activeStreams > 0) {
      throw new HttpError(409, 'PLAYBACK_IN_USE', 'Playback still has an active HTTP stream')
    }
    this.deletePlaybackInternal(playback)
  }

  deletePlaybackAdmin(id: string, force = false): void {
    const playback = this.getPlaybackAdmin(id)
    if (!force && playback.activeStreams > 0) {
      throw new HttpError(409, 'PLAYBACK_IN_USE', 'Playback still has an active HTTP stream')
    }
    this.deletePlaybackInternal(playback)
  }

  acquireStream(session: TorrentSession, playback: PlaybackRecord | null): () => void {
    if (this.totalActiveStreams >= this.config.maxConcurrentStreams) {
      throw new HttpError(429, 'STREAM_LIMIT_REACHED', 'Too many simultaneous HTTP streams')
    }
    if (playback !== null && playback.activeStreams >= this.config.maxStreamsPerPlayback) {
      throw new HttpError(429, 'PLAYBACK_STREAM_LIMIT_REACHED', 'This playback has too many simultaneous range requests')
    }
    this.totalActiveStreams += 1
    session.activeStreams += 1
    if (playback !== null) {
      playback.activeStreams += 1
      this.touchPlayback(playback)
    }

    let released = false
    return () => {
      if (released) return
      released = true
      this.totalActiveStreams = Math.max(0, this.totalActiveStreams - 1)
      session.activeStreams = Math.max(0, session.activeStreams - 1)
      session.touch()
      if (playback !== null) playback.activeStreams = Math.max(0, playback.activeStreams - 1)
    }
  }

  touchPlaybackFromStream(playback: PlaybackRecord | null): void {
    if (playback !== null) this.touchPlayback(playback)
  }

  playbackExpiresAt(playback: PlaybackRecord): number {
    return Math.min(
      playback.createdAt + this.config.playbackMaxMs,
      playback.lastSeenAt + this.config.playbackIdleMs,
    )
  }

  playbackJSON(playback: PlaybackRecord): Record<string, unknown> {
    return {
      id: playback.id,
      torrentId: playback.torrentId,
      fileId: playback.fileId,
      createdAt: new Date(playback.createdAt).toISOString(),
      lastSeenAt: new Date(playback.lastSeenAt).toISOString(),
      expiresAt: new Date(this.playbackExpiresAt(playback)).toISOString(),
      currentTime: playback.currentTime,
      duration: playback.duration,
      paused: playback.paused,
      activeStreams: playback.activeStreams,
    }
  }

  stats(): Record<string, unknown> {
    const memory = process.memoryUsage()
    return {
      uptimeSeconds: Math.floor(process.uptime()),
      torrents: this.sessions.size,
      playbacks: this.playbacks.size,
      activeStreams: this.totalActiveStreams,
      cacheBytes: this.totalCacheBytes(),
      downloadSpeed: Number(this.client.downloadSpeed) || 0,
      uploadSpeed: Number(this.client.uploadSpeed) || 0,
      engineOperational: this.isOperational,
      engineError: this.clientError,
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
      limits: {
        cacheBytes: this.config.cacheMaxBytes,
        maxTorrents: this.config.maxTorrents,
        maxPlaybacks: this.config.maxPlaybacks,
        maxConcurrentStreams: this.config.maxConcurrentStreams,
      },
    }
  }

  async runGarbageCollection(force = false): Promise<Record<string, number>> {
    let evictedPieces = 0
    let evictedBytes = 0
    const now = Date.now()
    const maxEvictions = 512

    const evict = async (session: TorrentSession, entry: { index: number; size: number }): Promise<void> => {
      if (evictedPieces >= maxEvictions || session.isPieceProtected(entry.index)) return
      if (await session.evictPiece(entry.index)) {
        evictedPieces += 1
        evictedBytes += entry.size
      }
    }

    // Sliding-window eviction: anything no longer needed by any viewer is
    // removed after a short grace period, independently of the hard cap.
    for (const session of this.sessions.values()) {
      const stale = session.cacheEntries()
        .filter((entry) => !session.isPieceProtected(entry.index))
        .filter((entry) => force || entry.tombstoned || now - entry.lastAccessAt >= this.config.evictionGraceMs)
        .sort((a, b) => a.lastAccessAt - b.lastAccessAt)
      for (const entry of stale) await evict(session, entry)

      if (session.cacheBytes > this.config.torrentCacheMaxBytes) {
        const overflow = session.cacheEntries()
          .filter((entry) => !session.isPieceProtected(entry.index))
          .sort((a, b) => a.lastAccessAt - b.lastAccessAt)
        for (const entry of overflow) {
          if (session.cacheBytes <= this.config.torrentCacheMaxBytes) break
          await evict(session, entry)
        }
      }
    }

    if (this.totalCacheBytes() > this.config.cacheMaxBytes) {
      const globalCandidates = [...this.sessions.values()].flatMap((session) => (
        session.cacheEntries()
          .filter((entry) => !session.isPieceProtected(entry.index))
          .map((entry) => ({ session, entry }))
      )).sort((a, b) => a.entry.lastAccessAt - b.entry.lastAccessAt)
      for (const candidate of globalCandidates) {
        if (this.totalCacheBytes() <= this.config.cacheMaxBytes) break
        await evict(candidate.session, candidate.entry)
      }
    }

    return {
      evictedPieces,
      evictedBytes,
      cacheBytes: this.totalCacheBytes(),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.maintenanceTimer)
    for (const playback of [...this.playbacks.values()]) this.deletePlaybackInternal(playback)
    for (const session of [...this.sessions.values()]) await session.destroy()
    this.sessions.clear()
    this.byInfoHash.clear()
    if (this.client.destroyed !== true) {
      await new Promise<void>((resolve) => {
        this.client.destroy((error?: Error) => {
          if (error) this.logger.warn({ error: error.message }, 'WebTorrent shutdown warning')
          resolve()
        })
      })
    }
    await rm(this.config.cacheDir, { recursive: true, force: true })
  }

  private touchPlayback(playback: PlaybackRecord): void {
    playback.lastSeenAt = Date.now()
    const session = this.sessions.get(playback.torrentId)
    session?.touch()
  }

  private deletePlaybackInternal(playback: PlaybackRecord): void {
    if (!this.playbacks.delete(playback.id)) return
    const session = this.sessions.get(playback.torrentId)
    if (session !== undefined) {
      session.playbackCount = Math.max(0, session.playbackCount - 1)
      session.deleteWindow(playbackWindowId(playback.id))
      session.touch()
    }
  }

  private expirePlaybacks(): void {
    const now = Date.now()
    for (const playback of this.playbacks.values()) {
      if (playback.activeStreams === 0 && this.playbackExpiresAt(playback) <= now) {
        this.deletePlaybackInternal(playback)
      }
    }
  }

  private totalCacheBytes(): number {
    let total = 0
    for (const session of this.sessions.values()) total += session.cacheBytes
    return total
  }

  private async maintenance(): Promise<void> {
    if (this.maintenanceRunning || this.closed) return
    this.maintenanceRunning = true
    try {
      this.expirePlaybacks()
      await this.runGarbageCollection(false)
      const now = Date.now()
      for (const session of [...this.sessions.values()]) {
        const idle = session.playbackCount === 0 && session.activeStreams === 0 && session.windows.size === 0
        if (idle && now - session.lastAccessAt >= this.config.torrentIdleMs) {
          await this.removeTorrent(session.id, true)
        }
      }
    } catch (error) {
      this.logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Maintenance cycle failed')
    } finally {
      this.maintenanceRunning = false
    }
  }

  private async removeExpiredErrorSessions(): Promise<void> {
    const threshold = Date.now() - Math.min(this.config.torrentIdleMs, 5 * 60 * 1000)
    for (const session of [...this.sessions.values()]) {
      if (session.state === 'error' && session.lastAccessAt < threshold) {
        await this.removeTorrent(session.id, true)
      }
    }
  }
}

function estimatedCursor(file: TorrentFileLike, currentTime: number | null, duration: number | null): number {
  if (currentTime === null || duration === null || duration <= 0) return file.offset
  const ratio = Math.max(0, Math.min(1, currentTime / duration))
  return file.offset + Math.floor(Math.max(0, file.length - 1) * ratio)
}

function playbackWindowId(id: string): string {
  return `playback:${id}`
}

function assertSafeCacheDirectory(directory: string): void {
  const resolved = path.resolve(directory)
  const temporaryRoot = path.resolve(os.tmpdir())
  const insideTemporaryRoot = resolved.startsWith(`${temporaryRoot}${path.sep}`)
  if (!insideTemporaryRoot || resolved.split(path.sep).filter(Boolean).length < 2) {
    throw new Error(`Refusing to use unsafe CACHE_DIR: ${resolved}`)
  }
}
