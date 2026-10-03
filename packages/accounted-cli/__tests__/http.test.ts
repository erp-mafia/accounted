import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { UnavailableError } from '../lib/errors.mjs'
import { send } from '../lib/http.mjs'

let server: http.Server | undefined

function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`)
    })
  })
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve) => server!.close(resolve))
    server = undefined
  }
})

describe('send', () => {
  it('posts the body with its length and returns status, headers and text', async () => {
    let seen: { method?: string; headers?: http.IncomingHttpHeaders; body?: string } = {}
    const base = await listen((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        seen = { method: req.method, headers: req.headers, body }
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'r1' })
        res.end('{"ok":"åäö"}')
      })
    })
    const res = await send({
      method: 'POST',
      url: `${base}/mcp`,
      headers: { 'Content-Type': 'application/json', 'X-Accounted-Client': 'accounted-cli-test' },
      body: '{"name":"Åkeri"}',
      timeoutMs: 5000,
    })
    expect(res.status).toBe(200)
    expect(res.text).toBe('{"ok":"åäö"}')
    expect(res.headers['x-request-id']).toBe('r1')
    expect(seen.method).toBe('POST')
    expect(seen.body).toBe('{"name":"Åkeri"}')
    expect(seen.headers?.['content-length']).toBe(String(Buffer.byteLength('{"name":"Åkeri"}')))
    expect(seen.headers?.['x-accounted-client']).toBe('accounted-cli-test')
    // The MCP server refuses foreign origins; the CLI never sends one.
    expect(seen.headers?.origin).toBeUndefined()
  })

  it('returns a redirect instead of following it', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(302, { Location: 'https://elsewhere.example' })
      res.end()
    })
    const res = await send({ method: 'GET', url: base, timeoutMs: 5000 })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://elsewhere.example')
  })

  it('gives up when no answer arrives in time', async () => {
    const base = await listen(() => {
      // Never answers.
    })
    await expect(send({ method: 'GET', url: base, timeoutMs: 100 })).rejects.toThrow(UnavailableError)
  })

  it('reports an unreachable server as unavailable', async () => {
    const base = await listen(() => {})
    const closed = base
    server!.close()
    server = undefined
    await expect(send({ method: 'GET', url: closed, timeoutMs: 2000 })).rejects.toThrow(/Could not reach/)
  })
})
