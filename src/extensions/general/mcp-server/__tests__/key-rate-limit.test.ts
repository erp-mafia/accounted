import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

// A key over its per-minute limit (issue #225): a tools/call answers a tool
// result a program can branch on (RATE_LIMITED, details.retry_after_seconds,
// details.limit_per_minute) and is counted per key; every other request keeps
// the plain HTTP 429. Both carry the wait the database answered.

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  mirrorToolCallToPostHog: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    validateApiKey: (...args: unknown[]) => mocks.validateApiKey(...args),
    createServiceClientNoCookies: vi.fn(() => ({
      from: vi.fn(() => {
        throw new Error('a rate-limited request must not touch tenant tables')
      }),
    })),
  }
})

vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../posthog-tool-call', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../posthog-tool-call')>()
  return { ...actual, mirrorToolCallToPostHog: (...args: unknown[]) => mocks.mirrorToolCallToPostHog(...args) }
})

import { handleMcpRequest } from '../server'
import { RATE_LIMIT_RETRY_AFTER_SECONDS } from '@/lib/auth/api-keys'

const ENDPOINT = 'http://localhost:3000/api/extensions/ext/mcp-server/mcp'
const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const KEY_ID = '22222222-2222-4222-8222-222222222222'

function rpc(method: string, params?: Record<string, unknown>, url = ENDPOINT): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gnubok_sk_limited' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, ...(params ? { params } : {}) }),
  })
}

function limited(rateLimit?: Record<string, unknown>) {
  return { error: 'Rate limit exceeded', status: 429, ...(rateLimit ? { rateLimit } : {}) }
}

const REAL_WAIT = { retryAfterSeconds: 17, limitPerMinute: 100, apiKeyId: KEY_ID, userId: 'user-1', companyId: COMPANY_ID }

function captureNextToolCalled(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const off = eventBus.on('mcp.tool_called', (payload) => {
      off()
      resolve(payload as unknown as Record<string, unknown>)
    })
  })
}

describe('MCP key over its per-minute limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.mirrorToolCallToPostHog.mockResolvedValue(undefined)
  })

  it('answers a tools/call as a RATE_LIMITED tool result with the real wait and the limit', async () => {
    mocks.validateApiKey.mockResolvedValue(limited(REAL_WAIT))
    const response = await handleMcpRequest(rpc('tools/call', { name: 'gnubok_list_customers', arguments: {} }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.id).toBe(7)
    expect(body.result.isError).toBe(true)
    expect(body.result.resultType).toBeUndefined()
    const payload = JSON.parse(body.result.content[0].text)
    expect(payload.error).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      details: { retry_after_seconds: 17, limit_per_minute: 100 },
    })
    expect(payload.error.message_en).toContain('100 requests per minute')
    expect(payload.error.message_en).toContain('Wait 17 seconds')
    expect(typeof payload.error.message_sv).toBe('string')
  })

  it('counts the limited call per key as an mcp.tool_called event', async () => {
    mocks.validateApiKey.mockResolvedValue(limited(REAL_WAIT))
    const eventPromise = captureNextToolCalled()
    await handleMcpRequest(rpc('tools/call', { name: 'gnubok_list_customers', arguments: {} }))
    const event = await eventPromise

    expect(event).toMatchObject({
      tool: 'gnubok_list_customers',
      actorType: 'api_key',
      actorId: KEY_ID,
      success: false,
      isError: true,
      errorCode: 'RATE_LIMITED',
      errorKind: 'rate_limited',
      userId: 'user-1',
      companyId: COMPANY_ID,
    })
    expect(mocks.mirrorToolCallToPostHog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'gnubok_list_customers', isError: true, errorCode: 'RATE_LIMITED', errorKind: 'rate_limited' }),
    )
  })

  it('does not name an unknown tool in the event', async () => {
    mocks.validateApiKey.mockResolvedValue(limited(REAL_WAIT))
    const eventPromise = captureNextToolCalled()
    const response = await handleMcpRequest(rpc('tools/call', { name: 'made_up_tool_name', arguments: {} }))
    expect(response.status).toBe(200)
    expect((await eventPromise).tool).toBe('<unknown>')
  })

  it('keeps the plain HTTP 429 for every other request, with the real wait in Retry-After', async () => {
    mocks.validateApiKey.mockResolvedValue(limited(REAL_WAIT))
    const response = await handleMcpRequest(rpc('tools/list'))

    expect(response.status).toBe(429)
    expect(response.headers.get('Content-Type')).toBe('text/plain')
    expect(response.headers.get('Retry-After')).toBe('17')
    expect(await response.text()).toBe('Rate limit exceeded')
  })

  it('falls back to the upper-bound wait and no limit when the database does not say', async () => {
    mocks.validateApiKey.mockResolvedValue(limited())

    const list = await handleMcpRequest(rpc('tools/list'))
    expect(list.status).toBe(429)
    expect(list.headers.get('Retry-After')).toBe(String(RATE_LIMIT_RETRY_AFTER_SECONDS))

    const call = await handleMcpRequest(rpc('tools/call', { name: 'gnubok_list_customers', arguments: {} }))
    const payload = JSON.parse((await call.json()).result.content[0].text)
    expect(payload.error.code).toBe('RATE_LIMITED')
    expect(payload.error.details).toEqual({ retry_after_seconds: RATE_LIMIT_RETRY_AFTER_SECONDS, limit_per_minute: null })
    expect(payload.error.message_en).toContain('per-minute request limit')
  })

  it('gives a stateless-core client its resultType', async () => {
    mocks.validateApiKey.mockResolvedValue(limited(REAL_WAIT))
    const response = await handleMcpRequest(
      rpc('tools/call', {
        name: 'gnubok_list_customers',
        arguments: {},
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      }),
    )
    const body = await response.json()
    expect(body.result.resultType).toBe('complete')
    expect(body.result.isError).toBe(true)
  })

  it('names accounted_ tools in the error on the accounted namespace', async () => {
    mocks.validateApiKey.mockResolvedValue(limited(REAL_WAIT))
    const response = await handleMcpRequest(
      rpc('tools/call', { name: 'accounted_list_customers', arguments: {} }, `${ENDPOINT}?tool_namespace=accounted`),
    )
    expect(response.status).toBe(200)
    const payload = JSON.parse((await response.json()).result.content[0].text)
    expect(payload.error.code).toBe('RATE_LIMITED')
  })
})

describe('MCP server instructions', () => {
  it('state the per-minute limit and how a limited call answers', async () => {
    const response = await handleMcpRequest(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      }),
    )
    const body = await response.json()
    expect(body.result.instructions).toContain('per-minute limit (100 by default)')
    expect(body.result.instructions).toContain('RATE_LIMITED')
    expect(body.result.instructions).toContain('retry_after_seconds')
  })
})
