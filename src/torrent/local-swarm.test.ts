import assert from 'node:assert/strict'
import { test } from 'node:test'
import WebTorrent from 'webtorrent'
import { loadConfig } from '../config.js'
import { TorrentManager } from './torrent-manager.js'

const enabled = process.env.RUN_TORRENT_INTEGRATION === '1'

test('downloads, evicts and re-downloads a piece from a local authorized swarm', {
  skip: !enabled,
  timeout: 45_000,
}, async () => {
  const content = Buffer.allocUnsafe(3 * 1024 * 1024)
  for (let index = 0; index < content.length; index += 1) content[index] = index % 251

  const seeder: any = new WebTorrent({
    tracker: false,
    dht: false,
    lsd: false,
    utPex: false,
    natUpnp: false,
    natPmp: false,
    utp: false,
  })
  const config = loadConfig({
    API_KEY: '0123456789abcdef0123456789abcdef',
    CACHE_DIR: `/tmp/torrent-window-gateway-swarm-test-${process.pid}`,
    ALLOW_PRIVATE_NETWORKS: 'true',
    PIECE_TIMEOUT_SECONDS: '10',
    WINDOW_BEHIND_MB: '0',
    LOG_LEVEL: 'silent',
  })
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const manager = new TorrentManager(config, logger)

  try {
    await manager.initialize()
    const seeded: any = await withTimeout(new Promise((resolve, reject) => {
      const torrent = seeder.seed(content, { name: 'authorized-test.mp4', announce: [] }, resolve)
      torrent.once('error', reject)
    }), 20_000)

    const { session } = await manager.addTorrent(seeded.torrentFile)
    await waitUntilUsable(session)
    const file = session.file(0)
    session.setWindow('integration', file.offset, file)
    session.refreshSelectionsNow()

    const gatewayPort = (session.torrent as any).client.torrentPort
    const added = seeded.addPeer(`127.0.0.1:${gatewayPort}`)
    assert.equal(added, true)
    await session.waitForPiece(0)
    const firstRead = await session.readPiece(0, 0, Math.min(65_536, session.torrent.pieceLength))
    assert.deepEqual(firstRead, content.subarray(0, firstRead.length))

    session.setWindow('integration', file.offset + file.length - 1, file)
    session.refreshSelectionsNow()
    const collection = await manager.runGarbageCollection(true)
    assert.ok(Number(collection.evictedPieces) >= 1)
    assert.equal(session.torrent.bitfield.get(0), false)

    session.setWindow('integration', file.offset, file)
    session.refreshSelectionsNow()
    await session.waitForPiece(0)
    const secondRead = await session.readPiece(0, 0, firstRead.length)
    assert.deepEqual(secondRead, firstRead)
  } finally {
    await Promise.allSettled([
      manager.close(),
      new Promise<void>((resolve) => seeder.destroy(() => resolve())),
    ])
  }
})

async function waitUntilUsable(session: { isUsable: boolean; once(event: string, listener: (...args: any[]) => void): unknown }): Promise<void> {
  if (session.isUsable) return
  await withTimeout(new Promise<void>((resolve, reject) => {
    session.once('ready', resolve)
    session.once('sessionError', reject)
  }), 20_000)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Local swarm integration timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
