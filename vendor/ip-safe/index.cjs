'use strict'

/**
 * bittorrent-tracker imports `ip` only in its optional tracker-server UDP
 * parser, where it calls toString(uint32). The gateway is a tracker client,
 * never a tracker server, but the root export eagerly loads that module.
 *
 * This deliberately tiny compatibility module avoids shipping the unpatched
 * `ip.isPublic`/`ip.isPrivate` implementation flagged by CVE-2024-29415.
 */
function toString (value, offset = 0, length) {
  if (typeof value === 'number') {
    const number = value >>> 0
    return [number >>> 24, (number >>> 16) & 255, (number >>> 8) & 255, number & 255].join('.')
  }

  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError('Expected a uint32 or byte array')
  }
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  const available = length ?? bytes.length - offset
  if (!Number.isInteger(offset) || offset < 0 || (available !== 4 && available !== 16) || offset + available > bytes.length) {
    throw new RangeError('Expected exactly 4 or 16 address bytes')
  }
  if (available === 4) return [...bytes.subarray(offset, offset + 4)].join('.')

  const groups = []
  for (let index = offset; index < offset + 16; index += 2) {
    groups.push(bytes.readUInt16BE(index).toString(16))
  }
  return groups.join(':')
}

module.exports = { toString }
