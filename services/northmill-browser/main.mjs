import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { chromium } from 'playwright'
import { NorthmillAdapter } from './northmill.mjs'
import { Sessions } from './sessions.mjs'
import { createServer } from './server.mjs'

const sessions = new Sessions(new NorthmillAdapter(chromium))
const server = createServer(sessions, process.env.NORTHMILL_BROWSER_TOKEN)
const cleanup = setInterval(() => { void sessions.sweep().catch(() => {}) }, 15_000)
server.requestTimeout = 30_000
server.headersTimeout = 10_000
const socket = process.env.NORTHMILL_BROWSER_SOCKET
if (socket) {
  try {
    if (!lstatSync(socket).isSocket()) throw new Error('Socket path is occupied')
    unlinkSync(socket)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  server.listen(socket, () => { chmodSync(socket, 0o600); console.log('Northmill browser service listening on private socket') })
} else {
  server.listen(Number(process.env.PORT || 3042), '127.0.0.1', () => console.log('Northmill browser service listening on loopback'))
}
async function stop() {
  clearInterval(cleanup)
  server.close()
  await sessions.close()
  process.exit(0)
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
