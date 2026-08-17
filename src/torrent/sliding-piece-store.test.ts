import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SlidingPieceStore } from './sliding-piece-store.js'
import type { TorrentLike } from './webtorrent-types.js'

function put(store: SlidingPieceStore, index: number, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    store.put(index, data, (error) => error ? reject(error) : resolve())
  })
}

function get(store: SlidingPieceStore, index: number, offset = 0, length?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    store.get(index, { offset, ...(length === undefined ? {} : { length }) }, (error, data) => {
      if (error) reject(error)
      else resolve(Buffer.from(data ?? []))
    })
  })
}

test('stores, partially reads and evicts individual pieces', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'piece-store-test-'))
  const fakeTorrent = {} as TorrentLike
  const store = new SlidingPieceStore(8, { path: directory, torrent: fakeTorrent })
  try {
    await put(store, 3, Buffer.from('abcdefgh'))
    assert.equal(store.residentBytes, 8)
    assert.equal(store.residentPieces, 1)
    assert.equal((await get(store, 3, 2, 3)).toString(), 'cde')

    store.beginEviction(3)
    await assert.rejects(get(store, 3), (error: unknown) => {
      return error instanceof Error && 'code' in error && error.code === 'ENOENT'
    })
    assert.equal(await store.evict(3), true)
    assert.equal(store.residentBytes, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
