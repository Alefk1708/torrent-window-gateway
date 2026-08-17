import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import parseTorrent from 'parse-torrent'
import type { AppConfig } from '../config.js'
import { HttpError, asError } from '../errors.js'

const BLOCKED = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6')
}

const TRACKER_PROTOCOLS = new Set(['udp:', 'http:', 'https:', 'ws:', 'wss:'])
const WEB_SEED_PROTOCOLS = new Set(['http:', 'https:'])

export async function parseAndSanitizeTorrent(input: string | Uint8Array, config: AppConfig): Promise<any> {
  if (typeof input === 'string' && !input.trim().toLowerCase().startsWith('magnet:?')) {
    throw new HttpError(400, 'INVALID_TORRENT_INPUT', 'Only magnet URIs or uploaded .torrent bytes are accepted')
  }

  let parsed: any
  try {
    parsed = await parseTorrent(input)
  } catch (error) {
    throw new HttpError(400, 'INVALID_TORRENT', `Could not parse torrent: ${asError(error).message}`)
  }
  if (typeof parsed?.infoHash !== 'string' || !/^[a-f0-9]{40,64}$/i.test(parsed.infoHash)) {
    throw new HttpError(400, 'INVALID_INFO_HASH', 'The torrent does not contain a valid info hash')
  }

  parsed.infoHash = parsed.infoHash.toLowerCase()
  parsed.announce = await filterUrls(toStringArray(parsed.announce), TRACKER_PROTOCOLS, config.allowPrivateNetworks)
  parsed.urlList = config.allowWebSeeds
    ? await filterUrls(toStringArray(parsed.urlList), WEB_SEED_PROTOCOLS, config.allowPrivateNetworks)
    : []

  // These magnet fields can make the server contact an attacker-selected HTTP
  // endpoint or private peer directly. Metadata must come from the swarm.
  delete parsed.xs
  delete parsed.as
  delete parsed.peerAddresses
  return parsed
}

async function filterUrls(urls: string[], protocols: Set<string>, allowPrivate: boolean): Promise<string[]> {
  const unique = [...new Set(urls)]
  const decisions = await Promise.all(unique.map(async (value) => ({ value, allowed: await isAllowedUrl(value, protocols, allowPrivate) })))
  return decisions.filter((decision) => decision.allowed).map((decision) => decision.value)
}

async function isAllowedUrl(value: string, protocols: Set<string>, allowPrivate: boolean): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (!protocols.has(parsed.protocol) || parsed.username !== '' || parsed.password !== '') return false
  if (allowPrivate) return true

  const rawHostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return false
  }
  const literalVersion = isIP(hostname)
  if (literalVersion !== 0) return !isBlockedAddress(hostname, literalVersion)

  try {
    const addresses = await withTimeout(lookup(hostname, { all: true, verbatim: true }), 3000)
    return addresses.length > 0 && addresses.every((entry) => !isBlockedAddress(entry.address, entry.family))
  } catch {
    return false
  }
}

function isBlockedAddress(address: string, family: number): boolean {
  try {
    return BLOCKED.check(address, family === 6 ? 'ipv6' : 'ipv4')
  } catch {
    return true
  }
}

export function isBlockedPeerAddress(input: string): boolean {
  let address = input.trim().toLowerCase()
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  const zoneIndex = address.indexOf('%')
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex)
  if (address.startsWith('::ffff:')) return true
  const family = isIP(address)
  return family === 0 || isBlockedAddress(address, family)
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
