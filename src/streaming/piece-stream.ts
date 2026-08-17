import { Readable } from 'node:stream'
import type { AppConfig } from '../config.js'
import type { TorrentSession } from '../torrent/torrent-session.js'
import type { TorrentFileLike } from '../torrent/webtorrent-types.js'

interface PieceStreamOptions {
  session: TorrentSession
  file: TorrentFileLike
  start: number
  end: number
  sourceId: string
  signal: AbortSignal
  config: AppConfig
  onProgress?: () => void
  onClose?: () => void
}

export function createPieceStream(options: PieceStreamOptions): Readable {
  return Readable.from(pieceIterator(options), {
    highWaterMark: options.config.streamChunkBytes,
  })
}

async function* pieceIterator(options: PieceStreamOptions): AsyncGenerator<Buffer> {
  const { session, file, signal, config, sourceId } = options
  const pieceLength = session.torrent.pieceLength
  let position = options.start
  let sent = 0
  const startedAt = Date.now()

  try {
    while (position <= options.end && !signal.aborted) {
      const globalOffset = file.offset + position
      const pieceIndex = Math.floor(globalOffset / pieceLength)
      const pieceOffset = globalOffset % pieceLength
      const remaining = options.end - position + 1
      const length = Math.min(config.streamChunkBytes, pieceLength - pieceOffset, remaining)

      session.setWindow(sourceId, globalOffset, file)
      await session.waitForPiece(pieceIndex, signal)
      const data = await session.readPiece(pieceIndex, pieceOffset, length, signal)
      if (signal.aborted) return

      sent += data.byteLength
      if (config.streamMaxBytesPerSecond > 0) {
        const targetElapsed = sent / config.streamMaxBytesPerSecond * 1000
        const delayMs = targetElapsed - (Date.now() - startedAt)
        if (delayMs > 1) await abortableDelay(delayMs, signal)
      }
      if (signal.aborted) return
      options.onProgress?.()
      yield data
      position += data.byteLength
    }
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return
    throw error
  } finally {
    session.deleteWindow(sourceId)
    options.onClose?.()
  }
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs)
    timer.unref()
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}
