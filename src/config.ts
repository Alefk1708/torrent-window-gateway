import path from 'node:path'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

export interface AppConfig {
  apiKey: string
  port: number
  host: string
  publicBaseUrl: string | null
  logLevel: string
  cacheDir: string
  cacheMaxBytes: number
  torrentCacheMaxBytes: number
  windowAheadBytes: number
  windowBehindBytes: number
  evictionGraceMs: number
  gcIntervalMs: number
  maxTorrents: number
  maxPlaybacks: number
  maxPlaybacksPerIp: number
  maxConcurrentStreams: number
  maxStreamsPerPlayback: number
  maxPeerConnections: number
  metadataTimeoutMs: number
  pieceTimeoutMs: number
  playbackIdleMs: number
  playbackMaxMs: number
  torrentIdleMs: number
  maxTorrentFileBytes: number
  maxTorrentBytes: number
  maxTorrentFiles: number
  maxTorrentPieces: number
  streamMaxBytesPerSecond: number
  streamChunkBytes: number
  uploadSlots: number
  uploadLimitBytesPerSecond: number
  downloadLimitBytesPerSecond: number
  corsOrigins: '*' | string[]
  frameAncestors: string
  bindPlaybackToIp: boolean
  allowPrivateNetworks: boolean
  allowWebSeeds: boolean
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function decimal(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`)
  }
  return parsed
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  if (/^(1|true|yes|on)$/i.test(raw)) return true
  if (/^(0|false|no|off)$/i.test(raw)) return false
  throw new Error(`${name} must be true or false`)
}

function parseOrigins(value: string | undefined): '*' | string[] {
  if (value === undefined || value.trim() === '' || value.trim() === '*') return '*'
  const origins = value.split(',').map((item) => item.trim()).filter(Boolean)
  if (origins.length === 0) return '*'
  for (const origin of origins) {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Invalid CORS origin: ${origin}`)
    }
  }
  return origins
}

function parseFrameAncestors(value: string | undefined): string {
  const raw = value?.trim() || '*'
  const tokens = raw.split(/\s+/)
  for (const token of tokens) {
    if (token === '*' || token === "'self'" || token === "'none'") continue
    const parsed = new URL(token)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Invalid FRAME_ANCESTORS value: ${token}`)
    }
  }
  return tokens.join(' ')
}

function parseBaseUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('PUBLIC_BASE_URL must use http or https')
  }
  return parsed.toString().replace(/\/$/, '')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = env.API_KEY?.trim() ?? ''
  if (Buffer.byteLength(apiKey) < 24) {
    throw new Error('API_KEY is required and must contain at least 24 bytes')
  }

  const cacheMaxBytes = integer(env, 'CACHE_MAX_MB', 768, 64, 1536) * MIB
  const torrentCacheMaxBytes = integer(env, 'TORRENT_CACHE_MAX_MB', 512, 32, 1536) * MIB
  if (torrentCacheMaxBytes > cacheMaxBytes) {
    throw new Error('TORRENT_CACHE_MAX_MB cannot exceed CACHE_MAX_MB')
  }

  const windowAheadBytes = integer(env, 'WINDOW_AHEAD_MB', 48, 4, 512) * MIB
  const windowBehindBytes = integer(env, 'WINDOW_BEHIND_MB', 8, 0, 128) * MIB
  if (windowAheadBytes + windowBehindBytes > torrentCacheMaxBytes) {
    throw new Error('The playback window must fit inside TORRENT_CACHE_MAX_MB')
  }

  const streamMbit = decimal(env, 'STREAM_MAX_MBIT', 20, 0, 1000)
  const uploadKbps = integer(env, 'UPLOAD_LIMIT_KBPS', 128, 0, 100_000)
  const downloadMbit = decimal(env, 'DOWNLOAD_LIMIT_MBIT', 0, 0, 10_000)

  return {
    apiKey,
    port: integer(env, 'PORT', 8000, 1, 65_535),
    host: env.HOST?.trim() || '0.0.0.0',
    publicBaseUrl: parseBaseUrl(env.PUBLIC_BASE_URL),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    cacheDir: path.resolve(env.CACHE_DIR?.trim() || '/tmp/torrent-window-gateway'),
    cacheMaxBytes,
    torrentCacheMaxBytes,
    windowAheadBytes,
    windowBehindBytes,
    evictionGraceMs: integer(env, 'EVICTION_GRACE_SECONDS', 15, 1, 600) * 1000,
    gcIntervalMs: integer(env, 'GC_INTERVAL_SECONDS', 5, 1, 60) * 1000,
    maxTorrents: integer(env, 'MAX_TORRENTS', 3, 1, 20),
    maxPlaybacks: integer(env, 'MAX_PLAYBACKS', 6, 1, 100),
    maxPlaybacksPerIp: integer(env, 'MAX_PLAYBACKS_PER_IP', 3, 1, 20),
    maxConcurrentStreams: integer(env, 'MAX_CONCURRENT_STREAMS', 6, 1, 100),
    maxStreamsPerPlayback: integer(env, 'MAX_STREAMS_PER_PLAYBACK', 2, 1, 10),
    maxPeerConnections: integer(env, 'MAX_PEER_CONNECTIONS', 24, 4, 200),
    metadataTimeoutMs: integer(env, 'METADATA_TIMEOUT_SECONDS', 60, 10, 600) * 1000,
    pieceTimeoutMs: integer(env, 'PIECE_TIMEOUT_SECONDS', 45, 5, 300) * 1000,
    playbackIdleMs: integer(env, 'PLAYBACK_IDLE_SECONDS', 90, 30, 3600) * 1000,
    playbackMaxMs: decimal(env, 'PLAYBACK_MAX_HOURS', 4, 0.25, 24) * 60 * 60 * 1000,
    torrentIdleMs: integer(env, 'TORRENT_IDLE_MINUTES', 15, 1, 1440) * 60 * 1000,
    maxTorrentFileBytes: integer(env, 'MAX_TORRENT_FILE_MB', 2, 1, 20) * MIB,
    maxTorrentBytes: decimal(env, 'MAX_TORRENT_SIZE_GB', 100, 1, 1000) * GIB,
    maxTorrentFiles: integer(env, 'MAX_TORRENT_FILES', 10_000, 1, 100_000),
    maxTorrentPieces: integer(env, 'MAX_TORRENT_PIECES', 100_000, 100, 2_000_000),
    streamMaxBytesPerSecond: streamMbit === 0 ? 0 : Math.floor(streamMbit * 1_000_000 / 8),
    streamChunkBytes: integer(env, 'STREAM_CHUNK_KB', 256, 16, 4096) * 1024,
    uploadSlots: integer(env, 'UPLOAD_SLOTS', 0, 0, 20),
    uploadLimitBytesPerSecond: uploadKbps * 1024,
    downloadLimitBytesPerSecond: downloadMbit === 0 ? -1 : Math.floor(downloadMbit * 1_000_000 / 8),
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
    frameAncestors: parseFrameAncestors(env.FRAME_ANCESTORS),
    bindPlaybackToIp: boolean(env, 'BIND_PLAYBACK_TO_IP', false),
    allowPrivateNetworks: boolean(env, 'ALLOW_PRIVATE_NETWORKS', false),
    allowWebSeeds: boolean(env, 'ALLOW_WEB_SEEDS', false),
  }
}

export const units = { MIB, GIB }
