/**
 * The trace one MCP JSON-RPC message runs in (handleMcpRequest): a valid
 * params._meta.traceparent first, else the trace the HTTP door opened, else
 * the request's traceparent header, else a new id. The staging insert
 * (pending_operations.trace_id), the mcp.tool_called telemetry (traceId) and
 * the X-Trace-Id response header all name the same one.
 *
 * Driven through handleMcpRequest, so the real staging insert runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { runWithTrace } from '@/lib/observability/trace-context-node'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { handleMcpRequest } from '../server'
import { createServiceClientNoCookies, validateApiKey } from '@/lib/auth/api-keys'
import { createServiceClient } from '@/lib/supabase/server'
import { createTableMockSupabase } from '@/tests/helpers'

const META_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const HEADER_TRACE = 'b7ad6b7169203331b7ad6b7169203331'
const OUTER_TRACE = 'cccccccccccccccccccccccccccccccc'
const traceparent = (traceId: string) => `00-${traceId}-00f067aa0ba902b7-01`

let db = createTableMockSupabase()

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  db = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' } },
    pending_operations: (calls) => {
      const insert = calls.find((c) => c.method === 'insert')
      if (!insert) return calls.some((c) => c.method === 'single' || c.method === 'maybeSingle') ? { data: null } : { data: [] }
      return { data: { id: 'op-1', created_at: '2026-10-29T10:00:00Z', ...(insert.args[0] as Record<string, unknown>) } }
    },
  })
  vi.mocked(createServiceClientNoCookies).mockReturnValue(db.supabase as never)
  vi.mocked(createServiceClient).mockReturnValue(db.supabase as never)
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    scopes: ['suppliers:write', 'suppliers:read'],
    apiKeyId: 'key-1',
    apiKeyName: 'Live Key',
    mode: 'live',
  } as Awaited<ReturnType<typeof validateApiKey>>)
})

function stageSupplier(opts: { meta?: Record<string, unknown>; headers?: Record<string, string> } = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token', ...opts.headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'gnubok_create_supplier', arguments: { name: 'Acme AB' }, ...(opts.meta ? { _meta: opts.meta } : {}) },
    }),
  })
}

function nextToolCalled(): Promise<EventPayload<'mcp.tool_called'>> {
  return new Promise((resolve) => {
    const off = eventBus.on('mcp.tool_called', (payload) => {
      off()
      resolve(payload as EventPayload<'mcp.tool_called'>)
    })
  })
}

/** The trace the response, the staging insert and the telemetry each name. */
async function tracesOf(call: () => Promise<Response>) {
  const event = nextToolCalled()
  const response = await call()
  const json = (await response.json()) as { result: { isError?: boolean } }
  expect(json.result.isError).not.toBe(true)
  const inserts = db.payloads('pending_operations', 'insert') as Array<Record<string, unknown>>
  expect(inserts).toHaveLength(1)
  return { header: response.headers.get('X-Trace-Id'), row: inserts[0]!.trace_id, telemetry: (await event).traceId }
}

describe('MCP message trace', () => {
  it('prefers a valid params._meta.traceparent over the HTTP header', async () => {
    const traces = await tracesOf(() =>
      handleMcpRequest(
        stageSupplier({ meta: { traceparent: traceparent(META_TRACE) }, headers: { traceparent: traceparent(HEADER_TRACE) } }),
      ),
    )
    expect(traces).toEqual({ header: META_TRACE, row: META_TRACE, telemetry: META_TRACE })
  })

  it('falls back to the HTTP traceparent header when _meta carries none or an invalid one', async () => {
    const traces = await tracesOf(() =>
      handleMcpRequest(
        stageSupplier({ meta: { traceparent: traceparent(META_TRACE).toUpperCase() }, headers: { traceparent: traceparent(HEADER_TRACE) } }),
      ),
    )
    expect(traces).toEqual({ header: HEADER_TRACE, row: HEADER_TRACE, telemetry: HEADER_TRACE })
  })

  it("takes the HTTP door's trace when the message carries none", async () => {
    const traces = await tracesOf(() => runWithTrace(OUTER_TRACE, () => handleMcpRequest(stageSupplier())))
    expect(traces).toEqual({ header: OUTER_TRACE, row: OUTER_TRACE, telemetry: OUTER_TRACE })
  })

  it('mints one trace for a message with neither, and every record names it', async () => {
    const traces = await tracesOf(() => handleMcpRequest(stageSupplier()))
    expect(traces.header).toMatch(/^[0-9a-f]{32}$/)
    expect(traces).toEqual({ header: traces.header, row: traces.header, telemetry: traces.header })
  })

  it('names a trace on a body that is not JSON-RPC', async () => {
    const response = await handleMcpRequest(
      new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token', traceparent: traceparent(HEADER_TRACE) },
        body: 'not json',
      }),
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('X-Trace-Id')).toBe(HEADER_TRACE)
  })
})
