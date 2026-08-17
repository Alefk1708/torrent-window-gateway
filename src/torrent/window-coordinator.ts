export interface PieceRange {
  from: number
  to: number
}

interface WindowSource {
  cursor: number
  fileStart: number
  fileEnd: number
  ahead: number
  behind: number
  touchedAt: number
}

export class WindowCoordinator {
  private readonly sources = new Map<string, WindowSource>()

  constructor(private readonly paddingPieces = 1) {}

  get size(): number {
    return this.sources.size
  }

  set(
    id: string,
    cursor: number,
    fileStart: number,
    fileEnd: number,
    ahead: number,
    behind: number,
  ): void {
    if (![cursor, fileStart, fileEnd, ahead, behind].every(Number.isSafeInteger)) {
      throw new Error('Playback window values must be safe integers')
    }
    if (fileStart < 0 || fileEnd < fileStart || ahead < 0 || behind < 0) {
      throw new Error('Invalid playback window bounds')
    }
    this.sources.set(id, {
      cursor: Math.max(fileStart, Math.min(cursor, fileEnd)),
      fileStart,
      fileEnd,
      ahead,
      behind,
      touchedAt: Date.now(),
    })
  }

  delete(id: string): void {
    this.sources.delete(id)
  }

  clear(): void {
    this.sources.clear()
  }

  criticalPieces(pieceLength: number, totalPieces: number): number[] {
    const result = new Set<number>()
    for (const source of this.sources.values()) {
      const piece = Math.min(totalPieces - 1, Math.floor(source.cursor / pieceLength))
      if (piece >= 0) result.add(piece)
    }
    return [...result]
  }

  ranges(pieceLength: number, totalPieces: number): PieceRange[] {
    if (totalPieces <= 0) return []
    const ranges: PieceRange[] = []
    for (const source of this.sources.values()) {
      const startByte = Math.max(source.fileStart, source.cursor - source.behind)
      const endByte = Math.min(source.fileEnd, source.cursor + source.ahead)
      const from = Math.max(0, Math.floor(startByte / pieceLength) - this.paddingPieces)
      const to = Math.min(totalPieces - 1, Math.floor(endByte / pieceLength) + this.paddingPieces)
      ranges.push({ from, to })
    }
    ranges.sort((a, b) => a.from - b.from || a.to - b.to)

    const merged: PieceRange[] = []
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous === undefined || range.from > previous.to + 1) {
        merged.push({ ...range })
      } else {
        previous.to = Math.max(previous.to, range.to)
      }
    }
    return merged
  }

  isProtected(index: number, pieceLength: number, totalPieces: number): boolean {
    return this.ranges(pieceLength, totalPieces).some((range) => index >= range.from && index <= range.to)
  }
}
