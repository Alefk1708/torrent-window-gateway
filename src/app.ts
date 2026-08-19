import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PassThrough, Readable } from 'node:stream'
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify'
import type { AppConfig } from './config.js'
import { HttpError } from './errors.js'
import { isAdminRequest, playbackTokenFromRequest, requireAdmin } from './http/auth.js'
import { RateLimiter } from './http/rate-limiter.js'
import { renderDocsPage, renderPlayerPage } from './player/page.js'
import { contentDisposition, mediaInfo } from './streaming/media-type.js'
import { createPieceStream } from './streaming/piece-stream.js'
import { parseByteRange } from './streaming/range.js'
import { TRANSCODE_HEIGHTS, parseStartSeconds, parseTranscodeHeight, type TranscodeJob } from './streaming/transcoder.js'
import { TorrentManager, type PlaybackHeartbeat, type PlaybackRecord } from './torrent/torrent-manager.js'
import type { TorrentSession } from './torrent/torrent-session.js'
import type { TorrentFileLike } from './torrent/webtorrent-types.js'

export async function buildApplication(config: AppConfig): Promise<{
  app: ReturnType<typeof Fastify>
  manager: TorrentManager
}> {
  const app = Fastify({
    logger: { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    exposeHeadRoutes: false,
    bodyLimit: config.maxTorrentFileBytes,
    requestTimeout: 30_000,
  })
  const manager = new TorrentManager(config, app.log)
  let openApi: string
  try {
    await manager.initialize()
    openApi = await readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8')
  } catch (error) {
    await Promise.allSettled([app.close(), manager.close()])
    throw error
  }
  const rateLimiter = new RateLimiter()

  app.addContentTypeParser(
    ['application/x-bittorrent', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  )

  app.addHook('onRequest', async (request, reply) => {
    applyCors(request, reply, config)
    if (request.method === 'OPTIONS') {
      return await reply.code(204).send()
    }
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin')
    if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    }
    return payload
  })

  app.addHook('onResponse', async (request, reply) => {
    app.log.info({
      requestId: request.id,
      method: request.method,
      path: request.url.split('?')[0],
      statusCode: reply.statusCode,
      remoteAddress: request.ip,
    }, 'Request completed')
  })

  app.setErrorHandler(async (error, request, reply) => {
    if (reply.sent) return
    const httpError = error instanceof HttpError ? error : null
    const normalizedError = error instanceof Error ? error : new Error(String(error))
    const statusCode = httpError?.statusCode ?? errorStatusCode(error) ?? 500
    const publicMessage = statusCode >= 500 && httpError === null ? 'Internal server error' : normalizedError.message
    if (statusCode >= 500) {
      app.log.error({ requestId: request.id, path: request.url.split('?')[0], error: normalizedError.message }, 'Request failed')
    }
    if (httpError?.details !== undefined && isRetryDetails(httpError.details)) {
      reply.header('Retry-After', String(httpError.details.retryAfter))
    }
    await reply.code(statusCode).type('application/json; charset=utf-8').send({
      error: httpError?.code ?? errorCode(error) ?? 'INTERNAL_ERROR',
      message: publicMessage,
      requestId: request.id,
      ...(httpError?.details === undefined ? {} : { details: httpError.details }),
    })
  })

  app.setNotFoundHandler(async (request, reply) => {
    await reply.code(404).send({ error: 'NOT_FOUND', message: 'Endpoint not found', requestId: request.id })
  })

  app.get('/', async () => ({
    name: 'Torrent Window Gateway',
    version: '1.1.0',
    purpose: 'HTTP Range streaming for authorized torrent content',
    docs: '/docs',
    openapi: '/openapi.yaml',
    health: '/health',
    transcoding: {
      enabled: manager.transcodes.isEnabled,
      available: manager.transcodes.available,
      heights: manager.transcodes.isEnabled && manager.transcodes.available ? [...TRANSCODE_HEIGHTS] : [],
    },
  }))

  app.get('/health', async (_request, reply) => {
    if (!manager.isOperational) return await reply.code(503).send({ status: 'degraded' })
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) }
  })
  app.get('/ready', async (_request, reply) => {
    if (!manager.isOperational) return await reply.code(503).send({ status: 'not_ready' })
    return { status: 'ready' }
  })
  app.get('/docs', async (_request, reply) => {
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
    return await reply.type('text/html; charset=utf-8').send(renderDocsPage())
  })
  app.get('/openapi.yaml', async (_request, reply) => {
    return await reply.type('application/yaml; charset=utf-8').send(openApi)
  })

  app.get('/api/v1/torrents', async (request) => {
    requireAdmin(request, config)
    rateLimiter.check(`api:${request.ip}`, 180, 60_000)
    return { torrents: manager.listSessions().map((session) => session.toJSON()) }
  })

  app.post('/api/v1/torrents', async (request, reply) => {
    requireAdmin(request, config)
    rateLimiter.check(`add-torrent:${request.ip}`, 10, 60_000)
    const input = torrentInput(request.body, config)
    const result = await manager.addTorrent(input)
    return await reply.code(result.reused ? 200 : 202).send({
      reused: result.reused,
      torrent: result.session.toJSON(),
      statusUrl: `/api/v1/torrents/${result.session.id}`,
    })
  })

  app.get('/api/v1/torrents/:id', async (request) => {
    requireAdmin(request, config)
    rateLimiter.check(`api:${request.ip}`, 180, 60_000)
    return { torrent: manager.getSession(pathParameter(request, 'id')).toJSON() }
  })

  app.get('/api/v1/torrents/:id/files/:fileId', async (request) => {
    requireAdmin(request, config)
    const session = manager.getSession(pathParameter(request, 'id'))
    const fileId = parseId(pathParameter(request, 'fileId'), 'fileId')
    const file = session.file(fileId)
    return { file: fileJSON(file, fileId) }
  })

  app.delete('/api/v1/torrents/:id', async (request, reply) => {
    requireAdmin(request, config)
    rateLimiter.check(`delete-torrent:${request.ip}`, 30, 60_000)
    const force = queryRecord(request).force === 'true'
    await manager.removeTorrent(pathParameter(request, 'id'), force)
    return await reply.code(204).send()
  })

  app.get('/api/v1/playbacks', async (request) => {
    requireAdmin(request, config)
    return { playbacks: manager.listPlaybacks().map((playback) => manager.playbackJSON(playback)) }
  })

  app.post('/api/v1/playbacks', async (request, reply) => {
    requireAdmin(request, config)
    rateLimiter.check(`create-playback:${request.ip}`, 30, 60_000)
    const body = objectBody(request.body)
    const torrentId = stringField(body, 'torrentId')
    const fileId = numberField(body, 'fileId')
    const result = manager.createPlayback(torrentId, fileId, request.ip)
    const urls = playbackUrls(request, config, result.playback, result.token)
    const session = manager.getSession(result.playback.torrentId)
    const file = session.requireStreamableFile(result.playback.fileId)
    const media = mediaInfo(file.name)
    const transcodeHeights = manager.transcodes.isEnabled && manager.transcodes.available && media.contentType.startsWith('video/')
      ? [...TRANSCODE_HEIGHTS]
      : []
    return await reply.code(201).send({
      playback: manager.playbackJSON(result.playback),
      token: result.token,
      ...urls,
      transcodeHeights,
      iframe: `<iframe src="${escapeAttribute(urls.playerUrl)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`,
    })
  })

  app.get('/api/v1/playbacks/:id', async (request) => {
    const playback = playbackForRequest(request, manager, config)
    const session = manager.getSession(playback.torrentId)
    return {
      playback: manager.playbackJSON(playback),
      torrent: runtimeTorrentJSON(session),
    }
  })

  app.patch('/api/v1/playbacks/:id', async (request) => {
    rateLimiter.check(`heartbeat:${request.ip}`, 300, 60_000)
    const playback = playbackForRequest(request, manager, config)
    const body = objectBody(request.body) as PlaybackHeartbeat
    manager.updatePlayback(playback, body)
    const session = manager.getSession(playback.torrentId)
    return {
      playback: manager.playbackJSON(playback),
      torrent: runtimeTorrentJSON(session),
    }
  })

  app.delete('/api/v1/playbacks/:id', async (request, reply) => {
    const id = pathParameter(request, 'id')
    const force = queryRecord(request).force === 'true'
    if (isAdminRequest(request, config)) {
      manager.deletePlaybackAdmin(id, force)
    } else {
      manager.deletePlayback(id, playbackTokenFromRequest(request), request.ip, force)
    }
    return await reply.code(204).send()
  })

  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/v1/stream/:torrentId/:fileId',
    handler: async (request, reply) => {
      rateLimiter.check(`stream:${request.ip}`, 180, 60_000)
      const torrentId = pathParameter(request, 'torrentId')
      const session = manager.getSession(torrentId)
      if (!session.isUsable) throw new HttpError(409, 'TORRENT_NOT_READY', 'Torrent is not ready')
      const fileId = parseId(pathParameter(request, 'fileId'), 'fileId')
      const file = session.requireStreamableFile(fileId)
      const playback = streamPlaybackForRequest(request, manager, config, session.id, fileId)

      const streamQuery = queryRecord(request)
      const heightParam = streamQuery.height ?? streamQuery.resolution
      if (heightParam !== undefined) {
        return await handleTranscodeRequest(request, reply, {
          manager,
          config,
          session,
          file,
          fileId,
          playback,
          heightParam,
          startParam: streamQuery.start,
        })
      }

      let range
      try {
        range = parseByteRange(request.headers.range, file.length)
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 416) {
          reply.header('Content-Range', `bytes */${file.length}`)
        }
        throw error
      }

      const contentLength = range.end - range.start + 1
      const media = mediaInfo(file.name)
      const applyRangeHeaders = (): void => {
        reply.header('Accept-Ranges', 'bytes')
        reply.header('Content-Type', media.contentType)
        reply.header('Content-Disposition', contentDisposition(file.name))
        reply.header('Content-Length', String(contentLength))
        reply.header('Cache-Control', 'private, no-store, max-age=0')
        if (range.partial) reply.header('Content-Range', `bytes ${range.start}-${range.end}/${file.length}`)
        reply.code(range.partial ? 206 : 200)
      }

      if (request.method === 'HEAD') {
        applyRangeHeaders()
        return await reply.send()
      }

      const release = manager.acquireStream(session, playback)
      const abortController = new AbortController()
      if (playback !== null) manager.registerStreamAborter(playback, abortController)
      const releaseStream = () => {
        if (playback !== null) manager.unregisterStreamAborter(playback, abortController)
        release()
      }
      const abort = () => abortController.abort()
      request.raw.once('aborted', abort)
      reply.raw.once('close', abort)

      const preflightId = `preflight:${randomUUID()}`
      const firstGlobalByte = file.offset + range.start
      try {
        session.setWindow(preflightId, firstGlobalByte, file)
        session.refreshSelectionsNow()
        await session.waitForPiece(Math.floor(firstGlobalByte / session.torrent.pieceLength), abortController.signal)
      } catch (error) {
        releaseStream()
        if (abortController.signal.aborted) {
          reply.hijack()
          return reply
        }
        throw error
      } finally {
        session.deleteWindow(preflightId)
      }

      applyRangeHeaders()
      const stream = createPieceStream({
        session,
        file,
        start: range.start,
        end: range.end,
        sourceId: `stream:${randomUUID()}`,
        signal: abortController.signal,
        config,
        onProgress: () => manager.touchPlaybackFromStream(playback),
        onClose: releaseStream,
      })
      stream.once('error', releaseStream)
      stream.once('close', releaseStream)
      return await reply.send(stream)
    },
  })

  app.get('/player/:torrentId/:fileId', async (request, reply) => {
    rateLimiter.check(`player:${request.ip}`, 120, 60_000)
    const torrentId = pathParameter(request, 'torrentId')
    const fileId = parseId(pathParameter(request, 'fileId'), 'fileId')
    const query = queryRecord(request)
    const playbackId = typeof query.playback === 'string' ? query.playback : ''
    const token = playbackTokenFromRequest(request)
    const playback = manager.authorizePlayback(playbackId, token, request.ip)
    if (playback.torrentId !== torrentId || playback.fileId !== fileId) {
      throw new HttpError(403, 'PLAYBACK_TARGET_MISMATCH', 'Playback token is not valid for this file')
    }
    const session = manager.getSession(torrentId)
    const file = session.requireStreamableFile(fileId)
    const media = mediaInfo(file.name)
    const nonce = randomBytes(18).toString('base64url')
    const streamUrl = `/api/v1/stream/${encodeURIComponent(session.id)}/${fileId}?playback=${encodeURIComponent(playback.id)}&token=${encodeURIComponent(token)}`
    const playbackUrl = `/api/v1/playbacks/${encodeURIComponent(playback.id)}`
    const transcodeHeights = manager.transcodes.isEnabled && manager.transcodes.available && media.contentType.startsWith('video/')
      ? [...TRANSCODE_HEIGHTS]
      : []
    reply.header('Cache-Control', 'private, no-store, max-age=0')
    reply.header('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; media-src 'self' blob:; connect-src 'self'; frame-ancestors ${config.frameAncestors}`)
    return await reply.type('text/html; charset=utf-8').send(renderPlayerPage({
      nonce,
      title: file.name,
      contentType: media.contentType,
      browserCompatible: media.browserCompatible,
      streamUrl,
      playbackUrl,
      playbackToken: token,
      transcodeHeights,
    }))
  })

  app.get('/api/v1/stats', async (request) => {
    requireAdmin(request, config)
    return {
      ...manager.stats(),
      torrentSessions: manager.listSessions().map((session) => runtimeTorrentJSON(session)),
    }
  })

  app.post('/api/v1/admin/gc', async (request) => {
    requireAdmin(request, config)
    rateLimiter.check(`gc:${request.ip}`, 10, 60_000)
    return await manager.runGarbageCollection(true)
  })

  app.get('/metrics', async (request, reply) => {
    requireAdmin(request, config)
    return await reply.type('text/plain; version=0.0.4; charset=utf-8').send(prometheusMetrics(manager))
  })

  return { app, manager }
}

function torrentInput(body: unknown, config: AppConfig): string | Uint8Array {
  if (Buffer.isBuffer(body)) {
    if (body.byteLength === 0 || body.byteLength > config.maxTorrentFileBytes) {
      throw new HttpError(413, 'TORRENT_FILE_TOO_LARGE', 'Invalid or oversized .torrent body')
    }
    return body
  }
  const object = objectBody(body)
  const magnet = stringField(object, 'magnet').trim()
  if (magnet.length > 16_384) throw new HttpError(413, 'MAGNET_TOO_LARGE', 'Magnet URI is too long')
  return magnet
}

function playbackForRequest(request: FastifyRequest, manager: TorrentManager, config: AppConfig): PlaybackRecord {
  const id = pathParameter(request, 'id')
  return isAdminRequest(request, config)
    ? manager.getPlaybackAdmin(id)
    : manager.authorizePlayback(id, playbackTokenFromRequest(request), request.ip)
}

function streamPlaybackForRequest(
  request: FastifyRequest,
  manager: TorrentManager,
  config: AppConfig,
  torrentId: string,
  fileId: number,
): PlaybackRecord | null {
  if (isAdminRequest(request, config)) return null
  const query = queryRecord(request)
  const playbackId = typeof query.playback === 'string' ? query.playback : ''
  const playback = manager.authorizePlayback(playbackId, playbackTokenFromRequest(request), request.ip)
  if (playback.torrentId !== torrentId || playback.fileId !== fileId) {
    throw new HttpError(403, 'PLAYBACK_TARGET_MISMATCH', 'Playback token is not valid for this stream')
  }
  return playback
}

interface TranscodeRequestContext {
  manager: TorrentManager
  config: AppConfig
  session: TorrentSession
  file: TorrentFileLike
  fileId: number
  playback: PlaybackRecord | null
  heightParam: unknown
  startParam: unknown
}

/**
 * Spawns ffmpeg reading the piece-backed stream endpoint over loopback and
 * relays its fragmented-MP4 output. The response has no length and no ranges:
 * seeking restarts the job at `start` seconds instead.
 */
async function handleTranscodeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: TranscodeRequestContext,
): Promise<unknown> {
  const { manager, config, session, file, fileId, playback } = ctx
  const height = parseTranscodeHeight(ctx.heightParam)
  const startSeconds = parseStartSeconds(ctx.startParam)
  if (playback === null) {
    throw new HttpError(401, 'PLAYBACK_TOKEN_REQUIRED', 'Transcoding requires playback and token query parameters')
  }
  const token = playbackTokenFromRequest(request)

  const applyHeaders = (): void => {
    reply.header('Content-Type', 'video/mp4')
    reply.header('Content-Disposition', transcodeDisposition(file.name, height))
    reply.header('Cache-Control', 'private, no-store, max-age=0')
    reply.code(200)
  }

  if (request.method === 'HEAD') {
    applyHeaders()
    return await reply.send()
  }

  // The loopback input below is the torrent byte stream and performs the real
  // stream accounting. Counting this outer ffmpeg response as a second stream
  // made one transcode consume two playback slots and caused quality switches
  // to hit MAX_STREAMS_PER_PLAYBACK. This controller only owns the ffmpeg job.
  const abortController = new AbortController()
  manager.registerStreamAborter(playback, abortController)
  let released = false
  const releaseStream = () => {
    if (released) return
    released = true
    manager.unregisterStreamAborter(playback, abortController)
  }
  const abort = () => abortController.abort()
  request.raw.once('aborted', abort)
  reply.raw.once('close', abort)

  let job: TranscodeJob | null = null
  try {
    job = manager.transcodes.start({
      playbackId: playback.id,
      sourceUrl: loopbackStreamUrl(config, session.id, fileId, playback.id, token),
      height,
      startSeconds,
    })
    await job.waitForStart()
  } catch (error) {
    job?.kill()
    releaseStream()
    if (abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      reply.hijack()
      return reply
    }
    throw error
  }

  abortController.signal.addEventListener('abort', () => job?.kill(), { once: true })
  applyHeaders()
  const pass = new PassThrough()
  job.stdout.pipe(pass)
  pass.once('close', releaseStream)
  pass.once('error', releaseStream)
  job.waitForExit().then(() => pass.end()).catch(() => pass.end())
  return await reply.send(pass)
}

function loopbackStreamUrl(
  config: AppConfig,
  torrentId: string,
  fileId: number,
  playbackId: string,
  token: string,
): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  const bracketed = host.includes(':') ? `[${host}]` : host
  const query = `playback=${encodeURIComponent(playbackId)}&token=${encodeURIComponent(token)}`
  return `http://${bracketed}:${config.port}/api/v1/stream/${encodeURIComponent(torrentId)}/${fileId}?${query}`
}

function transcodeDisposition(filename: string, height: number): string {
  const base = filename.replace(/\.[^./\\]+$/, '') || 'media'
  return contentDisposition(`${base}.${height}p.mp4`)
}

function playbackUrls(
  request: FastifyRequest,
  config: AppConfig,
  playback: PlaybackRecord,
  token: string,
): { playerUrl: string; streamUrl: string } {
  const base = publicBaseUrl(request, config)
  const query = `playback=${encodeURIComponent(playback.id)}&token=${encodeURIComponent(token)}`
  return {
    playerUrl: `${base}/player/${encodeURIComponent(playback.torrentId)}/${playback.fileId}?${query}`,
    streamUrl: `${base}/api/v1/stream/${encodeURIComponent(playback.torrentId)}/${playback.fileId}?${query}`,
  }
}

function publicBaseUrl(request: FastifyRequest, config: AppConfig): string {
  if (config.publicBaseUrl !== null) return config.publicBaseUrl
  const forwarded = request.headers['x-forwarded-host']
  const host = (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : request.headers.host) ?? ''
  if (!/^[a-z0-9._\-\[\]:]+$/i.test(host)) return `http://localhost:${config.port}`
  return `${request.protocol}://${host}`
}

function runtimeTorrentJSON(session: TorrentSession): Record<string, unknown> {
  return {
    id: session.id,
    state: session.state,
    peers: session.torrent.numPeers || 0,
    downloadSpeed: session.torrent.downloadSpeed || 0,
    uploadSpeed: session.torrent.uploadSpeed || 0,
    receivedBytes: session.torrent.received || 0,
    cacheBytes: session.cacheBytes,
    cachePieces: session.cachePieces,
    activeStreams: session.activeStreams,
    playbackCount: session.playbackCount,
  }
}

function fileJSON(file: { name: string; path: string; length: number }, id: number): Record<string, unknown> {
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
}

function applyCors(request: FastifyRequest, reply: FastifyReply, config: AppConfig): void {
  const origin = request.headers.origin
  const allowed = config.corsOrigins === '*' || (typeof origin === 'string' && config.corsOrigins.includes(origin))
  if (allowed) {
    reply.header('Access-Control-Allow-Origin', config.corsOrigins === '*' ? '*' : origin ?? '')
    reply.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, X-API-Key, X-Playback-Token')
    reply.header('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Type')
    if (config.corsOrigins !== '*') reply.header('Vary', 'Origin')
  } else if (request.method === 'OPTIONS') {
    throw new HttpError(403, 'CORS_ORIGIN_DENIED', 'Origin is not allowed')
  }
}

function prometheusMetrics(manager: TorrentManager): string {
  const stats = manager.stats() as any
  return [
    '# HELP torrent_gateway_torrents Active torrent sessions.',
    '# TYPE torrent_gateway_torrents gauge',
    `torrent_gateway_torrents ${Number(stats.torrents) || 0}`,
    '# HELP torrent_gateway_playbacks Active playback sessions.',
    '# TYPE torrent_gateway_playbacks gauge',
    `torrent_gateway_playbacks ${Number(stats.playbacks) || 0}`,
    '# HELP torrent_gateway_streams Active HTTP streams.',
    '# TYPE torrent_gateway_streams gauge',
    `torrent_gateway_streams ${Number(stats.activeStreams) || 0}`,
    '# HELP torrent_gateway_transcodes Active ffmpeg transcode jobs.',
    '# TYPE torrent_gateway_transcodes gauge',
    `torrent_gateway_transcodes ${Number(stats.transcodes?.active) || 0}`,
    '# HELP torrent_gateway_cache_bytes Resident piece cache bytes.',
    '# TYPE torrent_gateway_cache_bytes gauge',
    `torrent_gateway_cache_bytes ${Number(stats.cacheBytes) || 0}`,
    '# HELP torrent_gateway_download_bytes_per_second BitTorrent download speed.',
    '# TYPE torrent_gateway_download_bytes_per_second gauge',
    `torrent_gateway_download_bytes_per_second ${Number(stats.downloadSpeed) || 0}`,
    '# HELP process_resident_memory_bytes Resident process memory.',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${Number(stats.memory?.rss) || 0}`,
    '',
  ].join('\n')
}

function pathParameter(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>
  const value = params[name]
  if (typeof value !== 'string' || value === '') {
    throw new HttpError(400, 'INVALID_PATH_PARAMETER', `${name} is required`)
  }
  return value
}

function queryRecord(request: FastifyRequest): Record<string, unknown> {
  return request.query as Record<string, unknown>
}

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Buffer.isBuffer(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'A JSON object is required')
  }
  return body as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'INVALID_FIELD', `${name} must be a non-empty string`)
  }
  return value
}

function numberField(body: Record<string, unknown>, name: string): number {
  const value = body[name]
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new HttpError(400, 'INVALID_FIELD', `${name} must be a non-negative integer`)
  }
  return value as number
}

function parseId(value: string | undefined, name: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new HttpError(400, 'INVALID_PATH_PARAMETER', `${name} must be a non-negative integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, 'INVALID_PATH_PARAMETER', `${name} is too large`)
  return parsed
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function isRetryDetails(value: unknown): value is { retryAfter: number } {
  return typeof value === 'object' && value !== null && 'retryAfter' in value && typeof value.retryAfter === 'number'
}

function errorStatusCode(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('statusCode' in value)) return undefined
  return typeof value.statusCode === 'number' ? value.statusCode : undefined
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined
  return typeof value.code === 'string' ? value.code : undefined
}
