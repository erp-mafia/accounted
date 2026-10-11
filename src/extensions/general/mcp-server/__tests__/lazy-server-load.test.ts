import { describe, it, expect, vi } from 'vitest'

// The extension entry point is imported by lib/init on every route, so it must
// not evaluate ./server (the whole MCP tool graph) until an MCP request or an
// agent tool lookup needs it.
const { serverEvaluated, handleMcpRequest } = vi.hoisted(() => ({
  serverEvaluated: vi.fn(),
  handleMcpRequest: vi.fn(async () => new Response('ok', { status: 200 })),
}))

vi.mock('../server', () => {
  serverEvaluated()
  return {
    handleMcpRequest,
    tools: [
      {
        name: 'gnubok_list_accounts',
        description: 'List accounts',
        inputSchema: { type: 'object', properties: {} },
        execute: vi.fn(),
      },
    ],
  }
})

import { mcpServerExtension } from '../index'
import { agentToolRegistry } from '@/lib/agent/tools/registry'

function route(method: string) {
  const r = mcpServerExtension.apiRoutes?.find((x) => x.method === method && x.path === '/mcp')
  if (!r) throw new Error(`no ${method} /mcp route`)
  return r
}

describe('mcp-server lazy server load', () => {
  it('does not evaluate ./server when the extension is imported', () => {
    expect(mcpServerExtension.id).toBe('mcp-server')
    expect(serverEvaluated).not.toHaveBeenCalled()
  })

  it('does not load ./server for routes that never dispatch to it', async () => {
    const res = await route('GET').handler(new Request('https://app.example.com/api/extensions/ext/mcp-server/mcp'))
    expect(res.status).toBe(405)
    expect(serverEvaluated).not.toHaveBeenCalled()
  })

  it('loads ./server once, shared by the agent registry and the MCP POST handler', async () => {
    const [tool] = await Promise.all([
      agentToolRegistry.get('gnubok_list_accounts'),
      route('POST').handler(
        new Request('https://app.example.com/api/extensions/ext/mcp-server/mcp', { method: 'POST' }),
      ),
    ])
    expect(tool?.name).toBe('gnubok_list_accounts')
    expect(handleMcpRequest).toHaveBeenCalledTimes(1)

    await route('POST').handler(
      new Request('https://app.example.com/api/extensions/ext/mcp-server/mcp', { method: 'POST' }),
    )
    expect(handleMcpRequest).toHaveBeenCalledTimes(2)
    expect(serverEvaluated).toHaveBeenCalledTimes(1)
  })
})
