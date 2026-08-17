import type { EventEmitter } from 'node:events'

export interface BitFieldLike {
  get(index: number): boolean
  set(index: number, value: boolean): void
  buffer?: Uint8Array
}

export interface WireLike {
  destroyed?: boolean
  lt_donthave?: {
    donthave(index: number): void
  }
}

export interface TorrentFileLike {
  name: string
  path: string
  length: number
  offset: number
  _startPiece: number
  _endPiece: number
}

export interface ChunkStoreLike {
  get(
    index: number,
    options: { offset?: number; length?: number },
    callback: (error: Error | null, data?: Uint8Array) => void,
  ): void
}

export interface TorrentLike extends EventEmitter {
  infoHash: string
  name?: string
  length: number
  pieceLength: number
  lastPieceLength: number
  pieces: Array<unknown | null>
  files: TorrentFileLike[]
  bitfield: BitFieldLike
  store: ChunkStoreLike
  wires: WireLike[]
  ready: boolean
  destroyed: boolean
  downloaded: number
  received: number
  uploaded: number
  downloadSpeed: number
  uploadSpeed: number
  numPeers: number
  progress: number
  select(start: number, end: number, priority?: number): void
  deselect(start: number, end: number): void
  critical(start: number, end: number): void
  destroy(options: { destroyStore: boolean }, callback: (error?: Error | null) => void): void
  _markUnverified(index: number): void
  _checkDone?(): boolean
  _selections?: { clear(): void }
  _updateSelections?(): void
}
