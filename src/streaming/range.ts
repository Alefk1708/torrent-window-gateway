import { HttpError } from '../errors.js'

export interface ByteRange {
  start: number
  end: number
  partial: boolean
}

export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new HttpError(416, 'INVALID_FILE_SIZE', 'The file has no streamable bytes')
  }
  if (header === undefined || header.trim() === '') {
    return { start: 0, end: size - 1, partial: false }
  }

  const match = /^bytes\s*=\s*([^,]+)$/i.exec(header.trim())
  if (match?.[1] === undefined) {
    throw new HttpError(416, 'INVALID_RANGE', 'Only one HTTP byte range is supported')
  }

  const [rawStart, rawEnd, extra] = match[1].split('-')
  if (extra !== undefined || rawStart === undefined || rawEnd === undefined) {
    throw new HttpError(416, 'INVALID_RANGE', 'Malformed HTTP byte range')
  }

  let start: number
  let end: number
  if (rawStart.trim() === '') {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new HttpError(416, 'INVALID_RANGE', 'Invalid suffix byte range')
    }
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd.trim() === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new HttpError(416, 'INVALID_RANGE', 'Invalid HTTP byte range')
    }
    if (start >= size) {
      throw new HttpError(416, 'RANGE_NOT_SATISFIABLE', 'The requested range starts after the file ends')
    }
    end = Math.min(end, size - 1)
  }

  return { start, end, partial: true }
}
