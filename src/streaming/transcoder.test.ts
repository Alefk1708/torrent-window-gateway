import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from '../config.js'
import { HttpError } from '../errors.js'
import { renderPlayerPage } from '../player/page.js'
import { parseStartSeconds, parseTranscodeHeight, transcodeProfile, TranscodeManager, TRANSCODE_HEIGHTS } from './transcoder.js'

const silentLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
}

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    API_KEY: '0123456789abcdef0123456789abcdef',
    LOG_LEVEL: 'silent',
    ...overrides,
  })
}

test('parseTranscodeHeight accepts every ladder rung', () => {
  assert.equal(parseTranscodeHeight('1080'), 1080)
  assert.equal(parseTranscodeHeight('720p'), 720)
  assert.equal(parseTranscodeHeight(' 480P '), 480)
  assert.equal(parseTranscodeHeight('320'), 320)
  assert.equal(parseTranscodeHeight('144p'), 144)
})

test('parseTranscodeHeight rejects values outside the ladder', () => {
  for (const value of ['', 'abc', '2160', '0', '-5', '10', '10800', null, undefined, 720]) {
    assert.throws(() => parseTranscodeHeight(value), (error: unknown) => (
      error instanceof HttpError && error.statusCode === 400 && error.code === 'INVALID_HEIGHT'
    ), `expected ${String(value)} to be rejected`)
  }
})

test('lower resolutions use progressively smaller encode budgets', () => {
  assert.equal(transcodeProfile(1080).videoMaxRate, '5M')
  assert.equal(transcodeProfile(720).videoMaxRate, '2800k')
  assert.equal(transcodeProfile(480).audioBitrate, '96k')
  assert.equal(transcodeProfile(144).videoMaxRate, '350k')
  assert.ok(transcodeProfile(144).crf > transcodeProfile(1080).crf)
})

test('parseStartSeconds accepts offsets in seconds', () => {
  assert.equal(parseStartSeconds(undefined), null)
  assert.equal(parseStartSeconds(''), null)
  assert.equal(parseStartSeconds('0'), null)
  assert.equal(parseStartSeconds('123.5'), 123.5)
  for (const value of ['abc', '-1', '1e12', '999999999']) {
    assert.throws(() => parseStartSeconds(value), (error: unknown) => (
      error instanceof HttpError && error.statusCode === 400
    ), `expected ${String(value)} to be rejected`)
  }
})

test('configuration exposes transcode and stop-on-leave defaults', () => {
  const config = testConfig()
  assert.equal(config.ffmpegPath, 'ffmpeg')
  assert.equal(config.transcodeEnabled, true)
  assert.equal(config.maxTranscodes, 2)
  assert.equal(config.transcodeStartTimeoutMs, 10_000)
  assert.equal(config.torrentStopGraceMs, 10_000)
  assert.deepEqual([...TRANSCODE_HEIGHTS], [1080, 720, 480, 320, 144])
})

test('TranscodeManager refuses jobs when ffmpeg is unavailable', async () => {
  const config = testConfig({ FFMPEG_PATH: 'definitely-not-a-real-ffmpeg-binary' })
  const manager = new TranscodeManager(config, silentLogger)
  await manager.detectFFmpeg()
  assert.equal(manager.available, false)
  assert.throws(() => manager.start({ playbackId: 'p', sourceUrl: 'http://127.0.0.1:1/x', height: 720, startSeconds: null }), (error: unknown) => (
    error instanceof HttpError && error.statusCode === 501 && error.code === 'FFMPEG_UNAVAILABLE'
  ))
})

test('TranscodeManager refuses jobs when transcoding is disabled', () => {
  const config = testConfig({ TRANSCODE_ENABLED: 'false' })
  const manager = new TranscodeManager(config, silentLogger)
  assert.equal(manager.isEnabled, false)
  assert.throws(() => manager.start({ playbackId: 'p', sourceUrl: 'http://127.0.0.1:1/x', height: 720, startSeconds: null }), (error: unknown) => (
    error instanceof HttpError && error.statusCode === 501 && error.code === 'TRANSCODE_DISABLED'
  ))
})

test('player page renders the quality selector only when transcoding is available', () => {
  const pageOptions = {
    nonce: 'nonce-value',
    title: 'video.mkv',
    contentType: 'video/x-matroska',
    browserCompatible: false,
    streamUrl: '/api/v1/stream/uuid/0?playback=p&token=t',
    playbackUrl: '/api/v1/playbacks/p',
    playbackToken: 't',
  }
  const withHeights = renderPlayerPage({ ...pageOptions, transcodeHeights: [1080, 720, 480, 320, 144] })
  assert.match(withHeights, /id="quality"/)
  assert.match(withHeights, /1080p/)
  assert.match(withHeights, /transcodificar/)
  assert.match(withHeights, /pagehide/)
  assert.match(withHeights, /force=true/)

  const withoutHeights = renderPlayerPage({ ...pageOptions, transcodeHeights: [] })
  assert.doesNotMatch(withoutHeights, /id="quality"/)
  assert.match(withoutHeights, /transcodificação não está disponível/)
  assert.match(withoutHeights, /pagehide/)
})
