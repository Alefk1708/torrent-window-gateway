import path from 'node:path'

interface MediaInfo {
  contentType: string
  streamable: boolean
  browserCompatible: boolean
}

const TYPES: Record<string, MediaInfo> = {
  '.mp4': { contentType: 'video/mp4', streamable: true, browserCompatible: true },
  '.m4v': { contentType: 'video/mp4', streamable: true, browserCompatible: true },
  '.webm': { contentType: 'video/webm', streamable: true, browserCompatible: true },
  '.ogv': { contentType: 'video/ogg', streamable: true, browserCompatible: true },
  '.mov': { contentType: 'video/quicktime', streamable: true, browserCompatible: true },
  '.mkv': { contentType: 'video/x-matroska', streamable: true, browserCompatible: false },
  '.avi': { contentType: 'video/x-msvideo', streamable: true, browserCompatible: false },
  '.ts': { contentType: 'video/mp2t', streamable: true, browserCompatible: false },
  '.m2ts': { contentType: 'video/mp2t', streamable: true, browserCompatible: false },
  '.mp3': { contentType: 'audio/mpeg', streamable: true, browserCompatible: true },
  '.m4a': { contentType: 'audio/mp4', streamable: true, browserCompatible: true },
  '.aac': { contentType: 'audio/aac', streamable: true, browserCompatible: true },
  '.flac': { contentType: 'audio/flac', streamable: true, browserCompatible: true },
  '.ogg': { contentType: 'audio/ogg', streamable: true, browserCompatible: true },
  '.oga': { contentType: 'audio/ogg', streamable: true, browserCompatible: true },
  '.opus': { contentType: 'audio/ogg; codecs=opus', streamable: true, browserCompatible: true },
  '.wav': { contentType: 'audio/wav', streamable: true, browserCompatible: true },
  '.vtt': { contentType: 'text/vtt; charset=utf-8', streamable: true, browserCompatible: true },
  '.srt': { contentType: 'application/x-subrip; charset=utf-8', streamable: true, browserCompatible: false },
}

const FALLBACK: MediaInfo = {
  contentType: 'application/octet-stream',
  streamable: false,
  browserCompatible: false,
}

export function mediaInfo(filename: string): MediaInfo {
  return TYPES[path.extname(filename).toLowerCase()] ?? FALLBACK
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').slice(0, 180) || 'media'
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
