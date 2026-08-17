import { buildApplication } from './app.js'
import { loadConfig } from './config.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const { app, manager } = await buildApplication(config)
  let shuttingDown = false

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ reason }, 'Shutting down')

    const forceExit = setTimeout(() => {
      app.log.error('Graceful shutdown timed out')
      app.server.closeAllConnections()
      process.exit(1)
    }, 25_000)

    const results = await Promise.allSettled([app.close(), manager.close()])
    clearTimeout(forceExit)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected !== undefined) {
      app.log.error({ error: String(rejected.reason) }, 'Shutdown failed')
      process.exitCode = 1
      return
    }
    process.exitCode = exitCode
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('uncaughtException', (error) => {
    app.log.fatal({ error }, 'Uncaught exception')
    void shutdown('uncaughtException', 1)
  })
  process.once('unhandledRejection', (reason) => {
    app.log.fatal({ reason }, 'Unhandled promise rejection')
    void shutdown('unhandledRejection', 1)
  })

  await app.listen({ port: config.port, host: config.host })
  app.log.info({ host: config.host, port: config.port }, 'Torrent Window Gateway listening')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
