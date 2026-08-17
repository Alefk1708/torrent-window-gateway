/**
 * Usage:
 *   BASE_URL=https://your-app.koyeb.app API_KEY=... \
 *   node examples/client.mjs 'magnet:?xt=urn:btih:...'
 */

const baseUrl = (process.env.BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
const apiKey = process.env.API_KEY || ''
const magnet = process.argv[2] || ''

if (apiKey.length < 24 || !magnet.startsWith('magnet:?')) {
  console.error('Set BASE_URL/API_KEY and pass a magnet URI as the first argument.')
  process.exit(1)
}

const adminFetch = async (path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const body = response.status === 204 ? null : await response.json()
  if (!response.ok) throw new Error(`${response.status}: ${body?.message || response.statusText}`)
  return body
}

const added = await adminFetch('/api/v1/torrents', {
  method: 'POST',
  body: JSON.stringify({ magnet }),
})

const torrentId = added.torrent.id
let torrent = added.torrent
for (let attempt = 0; torrent.state !== 'ready'; attempt += 1) {
  if (torrent.state === 'error') throw new Error(torrent.error || 'Torrent failed')
  if (attempt >= 60) throw new Error('Metadata did not become ready in time')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  torrent = (await adminFetch(`/api/v1/torrents/${torrentId}`)).torrent
}

const file = torrent.files
  .filter((candidate) => candidate.streamable)
  .sort((a, b) => b.size - a.size)[0]
if (!file) throw new Error('No streamable file was found')

const result = await adminFetch('/api/v1/playbacks', {
  method: 'POST',
  body: JSON.stringify({ torrentId, fileId: file.id }),
})

console.log(JSON.stringify({
  torrent: torrent.name,
  file: file.name,
  playerUrl: result.playerUrl,
  iframe: result.iframe,
}, null, 2))
