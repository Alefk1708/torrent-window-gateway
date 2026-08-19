import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import type { AppConfig } from '../config.js'
import { HttpError } from '../errors.js'

export const TRANSCODE_HEIGHTS = [1080, 720, 480, 320, 144] as const

type TranscodeHeight = (typeof TRANSCODE_HEIGHTS)[number]

export type TranscodeProfile = {
  crf: number
  videoMaxRate: string
  videoBufferSize: string
  audioBitrate: string
}

const TRANSCODE_PROFILES: Record<TranscodeHeight, TranscodeProfile> = {
  1080: { crf: 23, videoMaxRate: '5M', videoBufferSize: '10M', audioBitrate: '128k' },
  720: { crf: 24, videoMaxRate: '2800k', videoBufferSize: '5600k', audioBitrate: '128k' },
  480: { crf: 25, videoMaxRate: '1400k', videoBufferSize: '2800k', audioBitrate: '96k' },
  320: { crf: 27, videoMaxRate: '800k', videoBufferSize: '1600k', audioBitrate: '64k' },
  144: { crf: 30, videoMaxRate: '350k', videoBufferSize: '700k', audioBitrate: '48k' },
}

export function transcodeProfile(height: number): TranscodeProfile {
  return TRANSCODE_PROFILES[height as TranscodeHeight] ?? TRANSCODE_PROFILES[720]
}

export interface TranscodeLoggerLike {
  debug(data: unknown, message?: string): void
  info(data: unknown, message?: string): void
  warn(data: unknown, message?: string): void
  error(data: unknown, message?: string): void
}

export function parseTranscodeHeight(value: unknown): number {
  const allowed = TRANSCODE_HEIGHTS.join('p, ') + 'p'
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'INVALID_HEIGHT', `height must be one of: ${allowed}`)
  }
  const match = /^(\d{1,4})p?$/i.exec(value.trim())
  const height = match === null ? Number.NaN : Number(match[1])
  if (!(TRANSCODE_HEIGHTS as readonly number[]).includes(height)) {
    throw new HttpError(400, 'INVALID_HEIGHT', `height must be one of: ${allowed}`)
  }
  return height
}

export function parseStartSeconds(value: unknown): number | null {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return null
  const seconds = typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 172_800) {
    throw new HttpError(400, 'INVALID_START', 'start must be a number of seconds between 0 and 172800')
  }
  return seconds === 0 ? null : seconds
}

interface TranscodeJobOptions {
  playbackId: string
  ffmpegPath: string
  sourceUrl: string
  height: number
  startSeconds: number | null
  startTimeoutMs: number
  logger: TranscodeLoggerLike
}

const MAX_STDERR_TAIL = 4000
const KILL_GRACE_MS = 3000

export class TranscodeJob {
  readonly id = `transcode:${randomUUID()}`
  readonly playbackId: string
  readonly height: number
  readonly stdout: Readable

  private readonly child: ChildProcess
  private readonly logger: TranscodeLoggerLike
  private readonly stderrTail: string[] = []
  private readonly startDeferred = createDeferred()
  private readonly exitDeferred = createDeferred()
  private startTimer: NodeJS.Timeout | null = null
  private killTimer: NodeJS.Timeout | null = null
  private startSettled = false
  private killed = false
  private exited = false

  constructor(options: TranscodeJobOptions) {
    this.playbackId = options.playbackId
    this.height = options.height
    this.logger = options.logger

    const profile = transcodeProfile(options.height)
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(options.startSeconds !== null ? ['-ss', options.startSeconds.toFixed(3)] : []),
      '-i', options.sourceUrl,
      '-map', '0:v:0', '-map', '0:a?',
      // Escaped comma: never upscale past the requested ladder rung.
      '-vf', `scale=-2:min(ih\\,${options.height})`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(profile.crf),
      '-maxrate', profile.videoMaxRate, '-bufsize', profile.videoBufferSize,
      '-pix_fmt', 'yuv420p', '-g', '48',
      '-c:a', 'aac', '-b:a', profile.audioBitrate, '-ac', '2',
      '-sn', '-dn',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ]
    this.child = spawn(options.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.stdout = this.child.stdout as Readable

    this.startTimer = setTimeout(() => {
      this.failStart(new HttpError(504, 'TRANSCODE_START_TIMEOUT', 'Timed out waiting for the first transcoded bytes'))
    }, options.startTimeoutMs)
    this.startTimer.unref()

    this.stdout.on('readable', this.maybeStarted)

    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString('utf8'))
      let total = this.stderrTail.reduce((sum, part) => sum + part.length, 0)
      while (total > MAX_STDERR_TAIL && this.stderrTail.length > 1) {
        const oldest = this.stderrTail[0]
        if (oldest === undefined) break
        total -= oldest.length
        this.stderrTail.shift()
      }
    })

    this.child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        this.failStart(new HttpError(501, 'FFMPEG_UNAVAILABLE', 'ffmpeg executable was not found'))
      } else {
        this.failStart(new HttpError(500, 'TRANSCODE_FAILED', `Could not start ffmpeg: ${error.message}`))
      }
    })

    // Lifecycle follows 'exit': a child 'close' event never fires while the
    // stdout pipe is paused and its buffered data stays unconsumed.
    this.child.once('exit', (code) => {
      this.exited = true
      if (this.startTimer !== null) clearTimeout(this.startTimer)
      this.stdout.removeListener('readable', this.maybeStarted)
      if (!this.startSettled) {
        if (this.stdout.readableLength > 0) {
          this.settleStart()
          this.startDeferred.resolve()
        } else if (this.killed) {
          this.settleStart()
          this.startDeferred.reject(abortedError())
        } else {
          this.failStart(new HttpError(500, 'TRANSCODE_FAILED', `ffmpeg exited before producing output: ${this.stderrMessage(code)}`))
        }
      }
      if (this.killed) this.logger.info({ jobId: this.id, code }, 'Transcode job stopped')
      else if (code !== 0) this.logger.warn({ jobId: this.id, code, stderr: this.stderrMessage(code) }, 'Transcode job failed')
      this.exitDeferred.resolve()
    })
  }

  get isExited(): boolean {
    return this.exited
  }

  waitForStart(): Promise<void> {
    return this.startDeferred.promise
  }

  waitForExit(): Promise<void> {
    return this.exitDeferred.promise
  }

  kill(): void {
    if (this.exited) return
    this.killed = true
    this.child.kill('SIGTERM')
    if (this.killTimer === null) {
      this.killTimer = setTimeout(() => {
        if (!this.exited) this.child.kill('SIGKILL')
      }, KILL_GRACE_MS)
      this.killTimer.unref()
    }
  }

  /**
   * First-byte detector. The 'readable' listener pauses the stream, and
   * neither Fastify nor a later 'data' listener resumes child stdio in that
   * state, so the listener detaches itself and the route pipes stdout into a
   * fresh PassThrough, which resumes it deterministically.
   */
  private readonly maybeStarted = (): void => {
    if (this.startSettled || this.stdout.readableLength === 0) return
    this.stdout.removeListener('readable', this.maybeStarted)
    if (this.startTimer !== null) clearTimeout(this.startTimer)
    this.settleStart()
    this.startDeferred.resolve()
  }

  private settleStart(): void {
    this.startSettled = true
  }

  private failStart(error: Error): void {
    if (this.startSettled) return
    this.settleStart()
    this.kill()
    this.startDeferred.reject(error)
  }

  private stderrMessage(code: number | null): string {
    const tail = this.stderrTail.join('').trim()
    if (tail !== '') return tail.split('\n').slice(-3).join(' | ').slice(0, 500)
    return `exit code ${code ?? 'unknown'}`
  }
}

export interface TranscodeStartOptions {
  playbackId: string
  sourceUrl: string
  height: number
  startSeconds: number | null
}

const execFileAsync = promisify(execFile)

export class TranscodeManager {
  private readonly jobs = new Map<string, TranscodeJob>()
  private readonly config: AppConfig
  private readonly logger: TranscodeLoggerLike

  constructor(config: AppConfig, logger: TranscodeLoggerLike) {
    this.config = config
    this.logger = logger
  }

  available = false

  get isEnabled(): boolean {
    return this.config.transcodeEnabled && this.config.maxTranscodes > 0
  }

  get activeCount(): number {
    return this.jobs.size
  }

  async detectFFmpeg(): Promise<void> {
    if (!this.isEnabled) return
    try {
      await execFileAsync(this.config.ffmpegPath, ['-version'], { timeout: 5000, windowsHide: true })
      this.available = true
      this.logger.info({ ffmpegPath: this.config.ffmpegPath }, 'ffmpeg detected; transcoding enabled')
    } catch (error) {
      this.available = false
      this.logger.warn(
        { ffmpegPath: this.config.ffmpegPath, error: error instanceof Error ? error.message : String(error) },
        'ffmpeg not found; resolution switching disabled',
      )
    }
  }

  start(options: TranscodeStartOptions): TranscodeJob {
    if (!this.isEnabled) {
      throw new HttpError(501, 'TRANSCODE_DISABLED', 'Transcoding is disabled on this gateway')
    }
    if (!this.available) {
      throw new HttpError(501, 'FFMPEG_UNAVAILABLE', 'ffmpeg is not available on this gateway')
    }
    if (this.jobs.size >= this.config.maxTranscodes) {
      throw new HttpError(429, 'TRANSCODE_LIMIT_REACHED', `At most ${this.config.maxTranscodes} transcode jobs may run simultaneously`)
    }
    const job = new TranscodeJob({
      playbackId: options.playbackId,
      ffmpegPath: this.config.ffmpegPath,
      sourceUrl: options.sourceUrl,
      height: options.height,
      startSeconds: options.startSeconds,
      startTimeoutMs: this.config.transcodeStartTimeoutMs,
      logger: this.logger,
    })
    this.jobs.set(job.id, job)
    void job.waitForExit().then(() => {
      this.jobs.delete(job.id)
    })
    return job
  }

  killForPlayback(playbackId: string): void {
    for (const job of this.jobs.values()) {
      if (job.playbackId === playbackId) job.kill()
    }
  }

  close(): void {
    for (const job of this.jobs.values()) job.kill()
    this.jobs.clear()
  }
}

function createDeferred(): { promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function abortedError(): Error {
  const error = new Error('Transcode request was aborted')
  error.name = 'AbortError'
  return error
}
