import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildApplication } from './app.js'
import { loadConfig } from './config.js'

test('serves public endpoints and protects operational endpoints', async () => {
  const apiKey = '0123456789abcdef0123456789abcdef'
  const cacheDir = `/tmp/torrent-window-gateway-test-${process.pid}`
  const config = loadConfig({
    API_KEY: apiKey,
    CACHE_DIR: cacheDir,
    LOG_LEVEL: 'silent',
  })
  const { app, manager } = await buildApplication(config)

  try {
    const health = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(health.statusCode, 200)
    assert.equal(health.json().status, 'ok')

    const openApi = await app.inject({ method: 'GET', url: '/openapi.yaml' })
    assert.equal(openApi.statusCode, 200)
    assert.match(openApi.body, /^openapi: 3\.1\.0/m)

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/playbacks',
      headers: { origin: 'https://viewer.example' },
    })
    assert.equal(preflight.statusCode, 204)
    assert.equal(preflight.headers['access-control-allow-origin'], '*')

    const denied = await app.inject({ method: 'GET', url: '/api/v1/stats' })
    assert.equal(denied.statusCode, 401)
    assert.equal(denied.json().error, 'UNAUTHORIZED')

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/stats',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    assert.equal(allowed.statusCode, 200)
    assert.equal(allowed.json().torrents, 0)

    const headerAllowed = await app.inject({
      method: 'GET',
      url: '/api/v1/stats',
      headers: { authorization: 'Bearer a-playback-token', 'x-api-key': apiKey },
    })
    assert.equal(headerAllowed.statusCode, 200)
  } finally {
    await Promise.allSettled([app.close(), manager.close()])
  }
})
