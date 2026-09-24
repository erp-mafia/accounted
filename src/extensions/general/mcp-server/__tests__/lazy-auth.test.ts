import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

// Lazy authentication (issue #1814 PR 2): a client with no token may connect,
// list the catalog and call the public documentation tools; anything that
// touches a company answers 401 + WWW-Authenticate at the transport level,
// which is what Claude / Claude Code / Codex turn into their Connect prompt.

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

// Skills come from the filesystem/registry; keep the list deterministic and
// free of Supabase so the public tools can run under the throwing client.
vi.mock('../skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skills')>()
  return {
    ...actual,
    findSkill: vi.fn().mockResolvedValue({ slug: 'own/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Private', summary: 'Company instructions', body: 'Private workflow', tier: 'own', tags: ['own'] }),
    loadAllSkills: vi.fn().mockResolvedValue([
      {
        slug: 'month-end-close',
        name: 'Month-end close',
        summary: 'Close a month.',
        tags: ['close'],
        tier: 'workflow',
        body: 'Steps…',
        applicability: null,
      },
    ]),
  }
})

import { handleMcpRequest } from '../server'
import { findSkill } from '../skills'

const ENDPOINT = 'http://localhost:3000/api/extensions/ext/mcp-server/mcp'

function rpc(
  method: string,
  params?: Record<string, unknown>,
  opts: { token?: string; ip?: string } = {}
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.ip) headers['x-forwarded-for'] = opts.ip
  return new Request(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, ...(params ? { params } : {}) }),
  })
}

describe('MCP lazy authentication', () => {
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

  it('answers initialize without a token and says the client is not connected', async () => {
    const response = await handleMcpRequest(rpc('initialize', { protocolVersion: '2025-06-18' }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.result.instructions).toContain('NOT CONNECTED YET')
    expect(body.result.instructions).toContain('gnubok_search_tools')
    expect(mocks.validateApiKey).not.toHaveBeenCalled()
  })

  it('the discovery instructions explain every callable_via value, and no longer say the bridge refuses writes', async () => {
    // Feedback seq 372962: "writes must be named directly" read as if any
    // client could. Until issue #2800 the honest answer was "a search-only
    // write is a dead end"; now a staging write rides gnubok_stage_tool and
    // only a write that commits directly is out of reach.
    const response = await handleMcpRequest(rpc('initialize', { protocolVersion: '2025-06-18' }))
    const body = await response.json()
    expect(body.result.instructions).not.toContain('writes must be named directly')
    expect(body.result.instructions).not.toContain('the bridge refuses writes')
    expect(body.result.instructions).toContain('callable_via')
    for (const reach of ['"call_tool"', '"stage_tool"', '"none"']) {
      expect(body.result.instructions).toContain(reach)
    }
    expect(body.result.instructions).toContain('gnubok_stage_tool')
    expect(body.result.instructions).toContain('gnubok_approve_pending_operation')
    expect(body.result.instructions).toContain('blocked_by')
  })

  it('lists the full default catalog without a token so protected tools can be called', async () => {
    const response = await handleMcpRequest(rpc('tools/list'))
    expect(response.status).toBe(200)
    const body = await response.json()
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name)
    expect(names).toContain('gnubok_search_tools')
    // A company-scoped tool is listed too: calling it is the connect trigger.
    expect(names).toContain('gnubok_list_companies')
    expect(names.length).toBeGreaterThan(20)
  })

  it('tools/list never serializes matcher-side search keywords', async () => {
    // Swedish search synonyms live on the tool definitions for
    // gnubok_search_tools matching only; the tools/list payload budget has
    // zero headroom, so they must never reach the wire.
    const response = await handleMcpRequest(rpc('tools/list'))
    expect(response.status).toBe(200)
    const body = await response.json()
    const raw = JSON.stringify(body.result.tools)
    expect(raw).not.toContain('"keywords"')
    expect(raw).not.toContain('bankkonto')
    expect(raw).not.toContain('lönekörning')
  })

  it('runs a public documentation tool without a token', async () => {
    const response = await handleMcpRequest(
      rpc('tools/call', { name: 'gnubok_list_skills', arguments: {} })
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.result.isError).not.toBe(true)
    const payload = JSON.parse(body.result.content[0].text)
    expect(payload.count).toBe(1)
    expect(payload.skills[0].slug).toBe('month-end-close')
    expect(mocks.validateApiKey).not.toHaveBeenCalled()
  })

  it('ignores a company_id on a public tool when anonymous instead of touching tenant tables', async () => {
    const response = await handleMcpRequest(
      rpc('tools/call', {
        name: 'gnubok_list_skills',
        arguments: { company_id: '11111111-1111-4111-8111-111111111111' },
      })
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.result.isError).not.toBe(true)
  })

  it('challenges a protected tool call with a transport-level 401 + WWW-Authenticate', async () => {
    const response = await handleMcpRequest(
      rpc('tools/call', { name: 'gnubok_list_companies', arguments: {} })
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toMatch(
      /^Bearer resource_metadata="http:\/\/localhost:3000\/\.well-known\/oauth-protected-resource"$/
    )
  })

  it.each([
    ['gnubok_load_skill', { slug: 'own/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    ['accounted_load_skill', { slug: 'own/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    ['gnubok_get_task', { kind: 'bookkeep' }],
    ['accounted_get_task', { kind: 'bookkeep' }],
  ])('requires a tenant before calling %s', async (name, args) => {
    const response = await handleMcpRequest(rpc('tools/call', { name, arguments: args }))
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata')
  })

  it.each([
    ['gnubok_load_skill', { slug: 'own/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', _keyScopes: ['agent:read'] }],
    ['gnubok_get_task', { kind: 'bookkeep' }],
  ])('requires agent:read for %s even from a valid key', async (name, args) => {
    const response = await handleMcpRequest(rpc('tools/call', { name, arguments: args }, { token: 'test-token' }))
    const result = (await response.json()).result
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('agent:read')
    expect(findSkill).not.toHaveBeenCalled()
  })

  it('loads private instructions through an authorized tenant key', async () => {
    mocks.validateApiKey.mockResolvedValue({ userId: 'user-1', companyId: '11111111-1111-4111-8111-111111111111', scopes: ['agent:read'], apiKeyId: 'key-1', apiKeyName: 'Test key', mode: 'live' })
    const slug = 'own/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const response = await handleMcpRequest(rpc('tools/call', { name: 'accounted_load_skill', arguments: { slug } }, { token: 'test-token' }))
    const result = (await response.json()).result
    expect(result.isError).not.toBe(true)
    expect(result.content[0].text).toContain('Private workflow')
    expect(findSkill).toHaveBeenCalledWith(slug, expect.anything(), '11111111-1111-4111-8111-111111111111')
  })

  it('names the metadata document on the host the client called', async () => {
    // app.gnubok.se is the machine host existing connectors are configured
    // with. Pinning the challenge to NEXT_PUBLIC_APP_URL pointed it at
    // app.accounted.se, and clients refused the mismatch against the document
    // app.gnubok.se serves about itself, so OAuth could never start there.
    const response = await handleMcpRequest(
      new Request('https://app.gnubok.se/api/extensions/ext/mcp-server/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'app.gnubok.se' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'gnubok_list_companies', arguments: {} },
        }),
      })
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://app.gnubok.se/.well-known/oauth-protected-resource"'
    )
  })

  it('ignores a Host that is not allowlisted and challenges with the canonical one', async () => {
    const response = await handleMcpRequest(
      new Request('https://spoofed.example/api/extensions/ext/mcp-server/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'spoofed.example' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'gnubok_list_companies', arguments: {} },
        }),
      })
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"'
    )
  })

  it('challenges tenant-scoped methods (resources/read, tasks/get) without a token', async () => {
    for (const [method, params] of [
      ['resources/read', { uri: 'Accounted://company/current' }],
      ['tasks/get', { taskId: 'x' }],
    ] as const) {
      const response = await handleMcpRequest(rpc(method, params as Record<string, unknown>))
      expect(response.status, method).toBe(401)
      expect(response.headers.get('WWW-Authenticate'), method).toContain('resource_metadata')
    }
  })

  it('keeps a tokenless unparseable body on the pre-lazy-auth answer (401, no detail)', async () => {
    const response = await handleMcpRequest(
      new Request(ENDPOINT, { method: 'POST', body: 'not json' })
    )
    expect(response.status).toBe(401)
  })

  it('rate-limits anonymous calls per truncated IP', async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({
      ok: false,
      response: new Response('slow down', { status: 429 }),
    })
    const response = await handleMcpRequest(
      rpc('tools/list', undefined, { ip: '203.0.113.42, 10.0.0.1' })
    )
    expect(response.status).toBe(429)
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'mcp:anonymous', identifier: '203.0.113.0/24' })
    )
  })

  it('never rate-limits or bypasses validation for a token bearer', async () => {
    const response = await handleMcpRequest(
      rpc('tools/call', { name: 'gnubok_list_skills', arguments: {} }, { token: 'gnubok_sk_x' })
    )
    expect(response.status).toBe(200)
    expect(mocks.validateApiKey).toHaveBeenCalledWith('gnubok_sk_x')
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
  })

  it('still rejects an invalid token with 401 even on an anonymous-capable method', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({ error: 'Invalid API key', status: 401 })
    const response = await handleMcpRequest(rpc('tools/list', undefined, { token: 'gnubok_sk_bad' }))
    expect(response.status).toBe(401)
  })
})
