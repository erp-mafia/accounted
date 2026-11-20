import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startStdioBridge, type StdioBridge } from '@/tests/stdio-bridge'

const packageDir = path.resolve(__dirname, '..')
const script = path.join(packageDir, 'index.mjs')
const { version } = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
  version: string
}
const BASE = `accounted-mcp/${version}`

function initialize(id: number, clientInfo: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo },
  })
}

function request(id: number, method: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })
}

let bridge: StdioBridge | undefined

async function start(env: Record<string, string> = {}): Promise<StdioBridge> {
  bridge = await startStdioBridge({
    script,
    urlEnv: 'ACCOUNTED_URL',
    env: { ACCOUNTED_API_KEY: 'gnubok_sk_test_bridge', ...env },
  })
  return bridge
}

afterEach(async () => {
  await bridge?.stop()
  bridge = undefined
})

describe('accounted-mcp User-Agent', () => {
  it('sends accounted-mcp/<version> before initialize and adds the client name from it', async () => {
    const b = await start()
    await b.send(request(0, 'ping'))
    await b.send(initialize(1, { name: 'claude-ai', version: '0.14.10' }))
    await b.send(request(2, 'tools/list'))

    expect(b.requests.map((r) => r.headers['user-agent'])).toEqual([
      BASE,
      `${BASE} (claude-ai/0.14.10)`,
      `${BASE} (claude-ai/0.14.10)`,
    ])
    for (const r of b.requests) {
      expect(r.headers['x-accounted-client']).toBeUndefined()
      expect(r.headers.authorization).toBe('Bearer gnubok_sk_test_bridge')
    }
  })

  it('forwards every message byte for byte, the initialize request included', async () => {
    const b = await start()
    const lines = [
      '{"params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Åsa <agent>","version":"1.0 beta"}},"method":"initialize", "id":1,"jsonrpc":"2.0"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"accounted_list_accounts","arguments":{"query":"Förbrukningsinventarier"}}}',
    ]
    for (const line of lines) await b.send(line)

    expect(b.requests.map((r) => r.body)).toEqual(lines.map((line) => Buffer.from(line, 'utf8')))
  })

  it('reduces the client name and version to [A-Za-z0-9._-], at most 64 characters each', async () => {
    const b = await start()
    await b.send(initialize(1, { name: 'Visual Studio Code', version: '1.105.1 (Universal)' }))
    await b.send(initialize(2, { name: `Åsa's <agent>${'x'.repeat(100)}`, version: 'v'.repeat(80) }))
    await b.send(request(3, 'tools/list'))

    const [first, second, third] = b.requests.map((r) => r.headers['user-agent'])
    expect(first).toBe(`${BASE} (Visual-Studio-Code/1.105.1-Universal)`)
    const name = `sa-s-agent-${'x'.repeat(53)}`
    expect(name).toHaveLength(64)
    expect(second).toBe(`${BASE} (${name}/${'v'.repeat(64)})`)
    expect(third).toBe(second)
  })

  it('keeps the bare User-Agent when clientInfo carries no usable name, and leaves out a missing version', async () => {
    const b = await start()
    await b.send(initialize(1, { name: '<>!', version: '1.0.0' }))
    await b.send(request(2, 'tools/list'))
    await b.send(initialize(3, { name: 'cursor-vscode' }))

    expect(b.requests.map((r) => r.headers['user-agent'])).toEqual([BASE, BASE, `${BASE} (cursor-vscode)`])
  })

  it('keeps the ACCOUNTED_CLIENT marker and reads no clientInfo when it is set', async () => {
    const b = await start({ ACCOUNTED_CLIENT: 'openclaw' })
    await b.send(initialize(1, { name: 'claude-ai', version: '0.14.10' }))
    await b.send(request(2, 'tools/list'))

    for (const r of b.requests) {
      expect(r.headers['x-accounted-client']).toBe('openclaw')
      expect(r.headers['user-agent']).toBe(BASE)
    }
  })
})
