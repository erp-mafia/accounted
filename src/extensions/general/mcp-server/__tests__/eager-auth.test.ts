import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

// Eager authentication (auth-mode.ts): `auth=required` on the endpoint URL
// turns lazy auth off for that URL, so a tokenless caller is challenged on
// every request, initialize included. claude.ai's Add-custom-connector dialog
// probes the URL without credentials and only reads a 401 as OAuth; a 200
// makes it pre-fill "None", which blocks the sign-in later.

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    validateApiKey: (...args: unknown[]) => mocks.validateApiKey(...args),
    createServiceClientNoCookies: vi.fn(() => ({
      from: vi.fn(() => {
        throw new Error('anonymous requests must not touch tenant tables')
      }),
    })),
  }
})

vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
}))

vi.mock('../skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skills')>()
  return {
    ...actual,
    loadAllSkills: vi.fn().mockResolvedValue([]),
  }
})

import { handleMcpRequest } from '../server'
import { isEagerAuthRequested } from '../auth-mode'

const ENDPOINT = 'http://localhost:3000/api/extensions/ext/mcp-server/mcp'
const CHALLENGE_RE =
  /^Bearer resource_metadata="http:\/\/localhost:3000\/\.well-known\/oauth-protected-resource(\?tool_namespace=accounted)?"$/

function rpc(
  method: string,
  params?: Record<string, unknown>,
  opts: { token?: string; query?: string } = {}
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const url = opts.query ? `${ENDPOINT}?${opts.query}` : ENDPOINT
  return new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, ...(params ? { params } : {}) }),
  })
}

describe('MCP eager authentication (auth=required)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.checkRateLimit.mockResolvedValue({ ok: true })
    mocks.validateApiKey.mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['companies:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test key',
      mode: 'live',
    })
  })

  it('challenges a tokenless initialize with a transport-level 401 + WWW-Authenticate', async () => {
    const response = await handleMcpRequest(
      rpc('initialize', { protocolVersion: '2025-06-18' }, { query: 'auth=required' })
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toMatch(CHALLENGE_RE)
    expect(mocks.validateApiKey).not.toHaveBeenCalled()
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
  })

  it('keeps the namespaced metadata pointer on the challenge', async () => {
    const response = await handleMcpRequest(
      rpc('initialize', { protocolVersion: '2025-06-18' }, { query: 'tool_namespace=accounted&client=claude-connector&auth=required' })
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain(
      '/.well-known/oauth-protected-resource?tool_namespace=accounted"'
    )
  })

  it('challenges the catalog and the public documentation tools as well', async () => {
    const list = await handleMcpRequest(rpc('tools/list', undefined, { query: 'auth=required' }))
    expect(list.status).toBe(401)
    const call = await handleMcpRequest(
      rpc('tools/call', { name: 'gnubok_list_skills', arguments: {} }, { query: 'auth=required' })
    )
    expect(call.status).toBe(401)
    expect(call.headers.get('WWW-Authenticate')).toMatch(CHALLENGE_RE)
  })

  it('is a no-op for a caller that holds a token', async () => {
    const response = await handleMcpRequest(
      rpc('tools/call', { name: 'gnubok_list_skills', arguments: {} }, { token: 'gnubok_sk_x', query: 'auth=required' })
    )
    expect(response.status).toBe(200)
    expect(mocks.validateApiKey).toHaveBeenCalledWith('gnubok_sk_x')
  })

  it('only the exact flag opts out of lazy authentication', async () => {
    for (const query of ['auth=optional', 'auth=Required', 'authx=required']) {
      const response = await handleMcpRequest(
        rpc('initialize', { protocolVersion: '2025-06-18' }, { query })
      )
      expect(response.status, query).toBe(200)
    }
    expect(mocks.validateApiKey).not.toHaveBeenCalled()
  })

  it('isEagerAuthRequested reads the flag off the request URL', () => {
    expect(isEagerAuthRequested(new Request(`${ENDPOINT}?auth=required`))).toBe(true)
    expect(isEagerAuthRequested(new Request(`${ENDPOINT}?tool_namespace=accounted&auth=required`))).toBe(true)
    expect(isEagerAuthRequested(new Request(ENDPOINT))).toBe(false)
    expect(isEagerAuthRequested(new Request(`${ENDPOINT}?auth=`))).toBe(false)
  })
})
