declare module 'webtorrent' {
  const WebTorrent: any
  export default WebTorrent
}

declare module 'parse-torrent' {
  const parseTorrent: (torrentId: unknown) => Promise<any>
  export default parseTorrent
}
