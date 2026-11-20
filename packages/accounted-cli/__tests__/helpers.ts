import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

export type Sent = {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

export type Reply = { status: number; headers?: Record<string, string>; text: string }

/** A JSON-RPC request body as the CLI sends it. */
export type RpcBody = {
  id?: unknown
  method: string
  params: {
    name?: string
    arguments?: Record<string, unknown>
    taskId?: string
    _meta?: Record<string, unknown>
    [key: string]: unknown
  }
}

/** A stand-in for http.send that records requests and answers from a handler. */
export function fakeSend(handler: (req: Sent, parsedBody: RpcBody) => Reply | Promise<Reply>) {
  const calls: Sent[] = []
  const send = async (request: Omit<Sent, 'headers'> & { headers?: Record<string, string> }) => {
    const req: Sent = { ...request, headers: request.headers ?? {} }
    calls.push(req)
    let parsed: unknown
    try {
      parsed = req.body ? JSON.parse(req.body) : undefined
    } catch {
      parsed = req.body
    }
    const reply = await handler(req, parsed as RpcBody)
    return { status: reply.status, headers: reply.headers ?? {}, text: reply.text }
  }
  return { send, calls }
}

export function json(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return { status, headers, text: JSON.stringify(body) }
}

/** A JSON-RPC success reply echoing the request id. */
export function rpcResult(request: { id?: unknown } | undefined, result: unknown): Reply {
  return json(200, { jsonrpc: '2.0', id: request?.id ?? null, result })
}

export function toolResult(data: unknown, extra: Record<string, unknown> = {}) {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    ...extra,
  }
}

/** Collects what is written to a stream. */
export function sink(isTTY = false) {
  let text = ''
  return {
    isTTY,
    write(chunk: string) {
      text += chunk
      return true
    },
    get text() {
      return text
    },
  }
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'accounted-cli-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function stdinFrom(text: string, isTTY = false) {
  const stream = Readable.from([Buffer.from(text, 'utf8')]) as Readable & { isTTY?: boolean }
  stream.isTTY = isTTY
  return stream
}

export const ORIGIN = 'https://app.accounted.se'
export const COMPANY = '11111111-1111-4111-8111-111111111111'
