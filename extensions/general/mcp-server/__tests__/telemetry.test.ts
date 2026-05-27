/**
 * Tests for `mcp.tool_called` telemetry emission.
 *
 * Verifies all four dispatcher exit points (success, execution error,
 * scope denied, unknown tool) emit a correctly-shaped event to the bus,
 * and that the event-log handler registers the new type for persistence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

// ── Mocks (mirrors receipt-matcher.test.ts setup) ────────────

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      // Only reports:read — enough to call gnubok_get_trial_balance, NOT enough
      // to call gnubok_create_invoice (invoices:write). Drives the scope-denied test.
      scopes: ['reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
    }),
    // Minimal supabase mock — agent_atom_registry resolves to empty so
    // gnubok_list_skills happy-path doesn't crash on its registry query.
    // company_settings + employees are also handled so the applicability
    // filter has data to work against.
    createServiceClientNoCookies: vi.fn(() => ({
      from: vi.fn((table: string) => {
        if (table === 'company_settings') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { entity_type: 'AB', vat_registered: true },
                  error: null,
                }),
              })),
            })),
          }
        }
        if (table === 'employees') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn().mockResolvedValue({ count: 1, data: null, error: null }),
              })),
            })),
          }
        }
        return {
          select: vi.fn(() => {
            // Chainable: loadAtomsAsSkills filters .eq(is_active).eq(mcp_exposed)
            // .is(parent_atom_id, null).order(); loadReferenceById uses
            // .eq(id).not(parent_atom_id,is,null).maybeSingle().
            const chain: Record<string, ReturnType<typeof vi.fn>> = {
              eq: vi.fn(() => chain),
              is: vi.fn(() => chain),
              not: vi.fn(() => chain),
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }
            return chain
          }),
        }
      }),
    })),
  }
})

import { handleMcpRequest } from '../server'

function mcpRequest(method: string, params?: Record<string, unknown>, id: number | string = 1): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

interface ToolCalledPayload {
  tool: string
  requiredScope: string | null
  actorType: string
  actorId: string | null
  actorLabel: string | null
  latencyMs: number
  success: boolean
  isError: boolean
  errorCode: string | null
  errorKind: 'execution' | 'scope_denied' | 'unknown_tool' | null
  requestId: string | number | null
  userId: string
  companyId: string
}

interface ToolsListCalledPayload {
  toolCount: number
  actorType: string
  actorId: string | null
  actorLabel: string | null
  latencyMs: number
  requestId: string | number | null
  userId: string
  companyId: string
}

interface ResourceReadPayload {
  uri: string
  kind: 'widget' | 'skill' | 'data' | 'unknown'
  success: boolean
  errorCode: string | null
  latencyMs: number
  actorType: string
  actorId: string | null
  actorLabel: string | null
  requestId: string | number | null
  userId: string
  companyId: string
}

async function captureNextToolCalledEvent(): Promise<ToolCalledPayload> {
  return new Promise<ToolCalledPayload>((resolve) => {
    const off = eventBus.on('mcp.tool_called', (payload) => {
      off()
      resolve(payload as ToolCalledPayload)
    })
  })
}

async function captureNextToolsListEvent(): Promise<ToolsListCalledPayload> {
  return new Promise<ToolsListCalledPayload>((resolve) => {
    const off = eventBus.on('mcp.tools_list_called', (payload) => {
      off()
      resolve(payload as ToolsListCalledPayload)
    })
  })
}

async function captureNextResourceReadEvent(): Promise<ResourceReadPayload> {
  return new Promise<ResourceReadPayload>((resolve) => {
    const off = eventBus.on('mcp.resource_read', (payload) => {
      off()
      resolve(payload as ResourceReadPayload)
    })
  })
}

describe('mcp.tool_called telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('emits on successful tool execution with success=true and a measured latencyMs', async () => {
    const eventPromise = captureNextToolCalledEvent()

    // gnubok_list_skills is unscoped + has no DB dependency, perfect for a happy-path test.
    const response = await handleMcpRequest(
      mcpRequest('tools/call', { name: 'gnubok_list_skills', arguments: {} })
    )
    const json = await response.json()
    expect(json.error).toBeUndefined()

    const event = await eventPromise
    expect(event.tool).toBe('gnubok_list_skills')
    expect(event.requiredScope).toBeNull() // unscoped
    expect(event.success).toBe(true)
    expect(event.isError).toBe(false)
    expect(event.errorCode).toBeNull()
    expect(event.errorKind).toBeNull()
    expect(event.actorType).toBe('api_key')
    expect(event.actorId).toBe('key-1')
    expect(event.actorLabel).toBe('Test Key')
    expect(event.userId).toBe('user-1')
    expect(event.companyId).toBe('company-1')
    expect(event.requestId).toBe(1)
    // Real wall-clock — non-negative number
    expect(typeof event.latencyMs).toBe('number')
    expect(event.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('emits errorKind=scope_denied when the API key lacks the required scope', async () => {
    const eventPromise = captureNextToolCalledEvent()

    // gnubok_create_invoice requires invoices:write; our test key has only reports:read.
    await handleMcpRequest(
      mcpRequest('tools/call', {
        name: 'gnubok_create_invoice',
        arguments: { customer_id: 'x', items: [] },
      })
    )

    const event = await eventPromise
    expect(event.tool).toBe('gnubok_create_invoice')
    expect(event.requiredScope).toBe('invoices:write')
    expect(event.success).toBe(false)
    expect(event.isError).toBe(true)
    expect(event.errorKind).toBe('scope_denied')
    expect(event.errorCode).toBe('INSUFFICIENT_SCOPE')
    // Scope denial exits before tool.execute() runs.
    expect(event.latencyMs).toBe(0)
  })

  it('emits errorKind=unknown_tool when the tool name does not exist', async () => {
    const eventPromise = captureNextToolCalledEvent()

    await handleMcpRequest(
      mcpRequest('tools/call', { name: 'gnubok_does_not_exist', arguments: {} })
    )

    const event = await eventPromise
    expect(event.tool).toBe('gnubok_does_not_exist')
    expect(event.requiredScope).toBeNull()
    expect(event.success).toBe(false)
    expect(event.isError).toBe(true)
    expect(event.errorKind).toBe('unknown_tool')
    expect(event.errorCode).toBe('UNKNOWN_TOOL')
    expect(event.latencyMs).toBe(0)
  })

  it('emits errorKind=execution when the tool throws inside execute()', async () => {
    const eventPromise = captureNextToolCalledEvent()

    // gnubok_load_skill throws on unknown slug — clean way to force an
    // execution error without mocking Supabase.
    await handleMcpRequest(
      mcpRequest('tools/call', {
        name: 'gnubok_load_skill',
        arguments: { slug: 'definitely-does-not-exist' },
      })
    )

    const event = await eventPromise
    expect(event.tool).toBe('gnubok_load_skill')
    expect(event.success).toBe(false)
    expect(event.isError).toBe(true)
    expect(event.errorKind).toBe('execution')
    expect(event.errorCode).toBeTruthy()
    // Execution path measures real latency, even if the tool exits quickly.
    expect(event.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('does NOT block the JSON-RPC response on telemetry — even if a handler throws', async () => {
    // Register a handler that throws synchronously. The bus already isolates
    // failures via Promise.allSettled, so the response should still arrive.
    eventBus.on('mcp.tool_called', () => {
      throw new Error('intentional handler boom')
    })

    const response = await handleMcpRequest(
      mcpRequest('tools/call', { name: 'gnubok_list_skills', arguments: {} })
    )
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.error).toBeUndefined()
    expect(json.result).toBeDefined()
  })
})

describe('mcp.tools_list_called telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('emits with toolCount filtered by the caller scopes', async () => {
    const eventPromise = captureNextToolsListEvent()

    await handleMcpRequest(mcpRequest('tools/list'))

    const event = await eventPromise
    // Caller has only reports:read — tools requiring other scopes are filtered out,
    // but unscoped tools (search_tools, list_skills, load_skill) and reports:read
    // tools are present. Just sanity-check the count is positive and bounded.
    expect(event.toolCount).toBeGreaterThan(0)
    expect(event.toolCount).toBeLessThan(100)
    expect(event.actorType).toBe('api_key')
    expect(event.userId).toBe('user-1')
    expect(event.companyId).toBe('company-1')
    expect(typeof event.latencyMs).toBe('number')
    expect(event.latencyMs).toBeGreaterThanOrEqual(0)
  })
})

describe('mcp.resource_read telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('emits kind=widget for a widget URI hit', async () => {
    const eventPromise = captureNextResourceReadEvent()

    await handleMcpRequest(
      mcpRequest('resources/read', { uri: 'ui://receipt-matcher/app.html' })
    )

    const event = await eventPromise
    expect(event.uri).toBe('ui://receipt-matcher/app.html')
    expect(event.kind).toBe('widget')
    expect(event.success).toBe(true)
    expect(event.errorCode).toBeNull()
  })

  it('emits kind=skill for a skill URI hit', async () => {
    const eventPromise = captureNextResourceReadEvent()

    await handleMcpRequest(
      mcpRequest('resources/read', { uri: 'gnubok://skill/quarterly-vat-review' })
    )

    const event = await eventPromise
    expect(event.uri).toBe('gnubok://skill/quarterly-vat-review')
    expect(event.kind).toBe('skill')
    expect(event.success).toBe(true)
    expect(event.errorCode).toBeNull()
  })

  it('emits kind=unknown success=false for an URI that matches nothing', async () => {
    const eventPromise = captureNextResourceReadEvent()

    await handleMcpRequest(
      mcpRequest('resources/read', { uri: 'gnubok://nonexistent/whatever' })
    )

    const event = await eventPromise
    expect(event.uri).toBe('gnubok://nonexistent/whatever')
    expect(event.kind).toBe('unknown')
    expect(event.success).toBe(false)
    expect(event.errorCode).toBe('RESOURCE_NOT_FOUND')
  })

  it('emits kind=unknown for a skill URI with an unknown slug', async () => {
    const eventPromise = captureNextResourceReadEvent()

    // The dispatcher only matches kind=skill when findSkill returns a hit;
    // unknown slugs fall through and end up as kind=unknown.
    await handleMcpRequest(
      mcpRequest('resources/read', { uri: 'gnubok://skill/does-not-exist' })
    )

    const event = await eventPromise
    expect(event.kind).toBe('unknown')
    expect(event.success).toBe(false)
    expect(event.errorCode).toBe('RESOURCE_NOT_FOUND')
  })
})

describe('event_log persistence registration', () => {
  it('includes all three MCP telemetry events in the persisted event types', async () => {
    // Read the file as text — the constant is module-private. This is a
    // deliberate string-level guard so a future refactor that drops one
    // of the events from the list trips the test.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const handlerPath = path.resolve(__dirname, '..', '..', '..', '..', 'lib', 'events', 'handlers', 'event-log-handler.ts')
    const text = await fs.readFile(handlerPath, 'utf-8')
    expect(text).toMatch(/'mcp\.tool_called'/)
    expect(text).toMatch(/'mcp\.tools_list_called'/)
    expect(text).toMatch(/'mcp\.resource_read'/)
  })
})
