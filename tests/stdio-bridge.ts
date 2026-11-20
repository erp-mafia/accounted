/**
 * Runs one of the stdio MCP bridges (packages/accounted-mcp,
 * packages/gnubok-mcp) as a child process against a local HTTP server that
 * records every request it forwards.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ForwardedRequest {
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export interface StdioBridge {
  /** Every request the bridge forwarded, in arrival order. */
  requests: ForwardedRequest[]
  /** Writes one line to the bridge's stdin and resolves with the next line it prints. */
  send(line: string): Promise<string>
  /** Ends stdin, waits for the bridge to exit and stops the server. */
  stop(): Promise<void>
}

const REPLY_TIMEOUT_MS = 10_000

/**
 * Starts the bridge at `script` with exactly `env` (nothing inherited from the
 * test process) plus `urlEnv` pointing at the recording server. The server
 * answers a request with an id with an empty JSON-RPC result, and a
 * notification with 202.
 */
export async function startStdioBridge(options: {
  script: string
  urlEnv: string
  env: Record<string, string>
}): Promise<StdioBridge> {
  const requests: ForwardedRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ headers: req.headers, body })
      let id: unknown
      try {
        id = (JSON.parse(body.toString('utf8')) as { id?: unknown }).id
      } catch {
        id = undefined
      }
      if (id === undefined || id === null) {
        res.writeHead(202)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const child = spawn(process.execPath, [options.script], {
    // Next types ProcessEnv with a required NODE_ENV; the bridge deliberately gets none.
    env: { ...options.env, [options.urlEnv]: `http://127.0.0.1:${port}/mcp` } as NodeJS.ProcessEnv,
    stdio: 'pipe',
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => (stderr += chunk))

  const lines: string[] = []
  const waiting: Array<(line: string) => void> = []
  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    pending += chunk
    let newline
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      const resolve = waiting.shift()
      if (resolve) resolve(line)
      else lines.push(line)
    }
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

  return {
    requests,
    send(line) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no reply from the bridge within ${REPLY_TIMEOUT_MS} ms; stderr: ${stderr}`)),
          REPLY_TIMEOUT_MS
        )
        const settle = (reply: string) => {
          clearTimeout(timer)
          resolve(reply)
        }
        const buffered = lines.shift()
        if (buffered !== undefined) settle(buffered)
        else waiting.push(settle)
        child.stdin.write(`${line}\n`)
      })
    },
    async stop() {
      child.stdin.end()
      await exited
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
