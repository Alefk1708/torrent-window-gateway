import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from '../config.js'
import { isBlockedPeerAddress, parseAndSanitizeTorrent } from './tracker-sanitizer.js'

test('blocks local/private peer targets and accepts public literals', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '10.0.0.4', '169.254.169.254', '192.168.1.5', '::1', '[fc00::1]', '::ffff:127.0.0.1']) {
    assert.equal(isBlockedPeerAddress(address), true, address)
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isBlockedPeerAddress(address), false, address)
  }
  assert.equal(isBlockedPeerAddress('not-an-ip.example'), true)
})

test('drops private tracker literals from a magnet', async () => {
  const config = loadConfig({
    API_KEY: '0123456789abcdef0123456789abcdef',
    CACHE_DIR: `/tmp/torrent-window-gateway-sanitizer-test-${process.pid}`,
  })
  const magnet = [
    'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
    'tr=udp%3A%2F%2F127.0.0.1%3A6969',
    'tr=udp%3A%2F%2F%5B%3A%3A1%5D%3A6969',
    'tr=udp%3A%2F%2F1.1.1.1%3A6969',
  ].join('&')
  const parsed = await parseAndSanitizeTorrent(magnet, config)
  assert.deepEqual(parsed.announce, ['udp://1.1.1.1:6969'])
})
