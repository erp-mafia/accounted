/**
 * Tests for the gnubok_call_tool bridge in the MCP dispatcher.
 *
 * Server-side, every tool has always been callable: `tools/call` resolves the
 * name against the whole `tools` array, and `isDefaultCatalogTool` gates only
 * what tools/list SHOWS. The failure was purely client-side, and DECISIONS.md
 * records the consequence on 2026-08-26: `gnubok_reconcile_match` had to be
 * promoted back into the default catalog because "a search-only tool is
 * uncallable on Claude.ai".
 *
 * The bridge gives such a client one visible name to forward through. It is
 * implemented as a REWRITE ahead of tool resolution rather than as a wrapper
 * that calls the inner tool's execute(), because everything between resolution
 * and execute (scope check, unknown-argument guard, company routing, the
 * test-key write block, staging _meta, telemetry) must apply to the real
 * target. These tests exist to prove it does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        }
        return () => chain
      },
    },
  )
  const membershipChain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({
              data: { company_id: '11111111-1111-4111-8111-111111111111', role: 'owner' },
              error: null,
            })
        }
        return () => membershipChain
      },
    },
  )
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['transactions:read', 'reports:read', 'pending_operations:approve'],
      apiKeyId: 'key-1',
      apiKeyName: 'Live Key',
      mode: 'live',
    }),
    createServiceClientNoCookies: vi.fn(() => ({
      from: (table: string) => (table === 'company_members' ? membershipChain : chain),
      rpc: () => chain,
    })),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { handleMcpRequest, tools, isDefaultCatalogTool } from '../server'
import { validateApiKey, extractBearerToken } from '@/lib/auth/api-keys'

function mcpToolCall(name: string, args: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
}

interface ToolCalledEvent {
  tool: string
  success: boolean
  isError: boolean
  errorKind: string | null
  latencyMs: number
}

function captureNextToolCalled(): Promise<ToolCalledEvent> {
  return new Promise((resolve) => {
    const off = eventBus.on('mcp.tool_called', (payload) => {
      off()
      resolve(payload as unknown as ToolCalledEvent)
    })
  })
}

async function parsedToolResult(
  response: Response,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: { text: string }[] }
  return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) }
}

const bridgeTool = tools.find((t) => t.name === 'gnubok_call_tool')!

describe('gnubok_call_tool registration', () => {
  it('is in the default catalog and read-only', () => {
    expect(bridgeTool).toBeDefined()
    expect(isDefaultCatalogTool(bridgeTool)).toBe(true)
    expect(bridgeTool.annotations.readOnlyHint).toBe(true)
  })

  it('has no direct implementation: the dispatcher rewrite is load-bearing', async () => {
    // If this ever resolves instead of throwing, the rewrite was removed and
    // every bridged call would have skipped the read-only check above it.
    await expect(
      bridgeTool.execute({}, 'company-id', 'user-id', {} as never, { type: 'api_key' }),
    ).rejects.toThrow(/no direct implementation/i)
  })
})

describe('gnubok_call_tool bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('forwards to the inner tool and attributes telemetry to it, not to the wrapper', async () => {
    const eventPromise = captureNextToolCalled()

    await handleMcpRequest(mcpToolCall('gnubok_call_tool', { tool: 'gnubok_list_skills' }))

    const event = await eventPromise
    expect(event.tool).toBe('gnubok_list_skills')
    expect(event.errorKind).not.toBe('bridge_refused')
  })

  it('reaches a search-only read tool, which is the whole point', async () => {
    const searchOnlyRead = tools.find(
      (t) => !isDefaultCatalogTool(t) && t.annotations.readOnlyHint === true,
    )!
    expect(searchOnlyRead).toBeDefined()
    const eventPromise = captureNextToolCalled()

    await handleMcpRequest(mcpToolCall('gnubok_call_tool', { tool: searchOnlyRead.name }))

    const event = await eventPromise
    expect(event.tool).toBe(searchOnlyRead.name)
    expect(event.errorKind).not.toBe('bridge_refused')
  })

  it('refuses a write target so the staging and approval contract stays visible', async () => {
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', {
        tool: 'gnubok_approve_pending_operation',
        arguments: { operation_id: 'op-1' },
      }),
    )
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toContain('gnubok_approve_pending_operation')
    const event = await eventPromise
    expect(event.errorKind).toBe('bridge_refused')
    // Refused before execute(): nothing is staged, nothing is approved.
    expect(event.latencyMs).toBe(0)
  })

  it('still refuses a staging write, and names the bridge that carries it', async () => {
    // gnubok_call_tool is annotated read-only and may be always-allowed in a
    // client. It must never start staging writes under that consent
    // (issue #2800): the write half is a separate tool with a separate name.
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', { tool: 'gnubok_reconcile_unmatch', arguments: {} }),
    )
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toContain('gnubok_stage_tool')
    expect((await eventPromise).errorKind).toBe('bridge_refused')
  })

  it('refuses a call with no tool name', async () => {
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(mcpToolCall('gnubok_call_tool', {}))
    const { isError } = await parsedToolResult(response)

    expect(isError).toBe(true)
    const event = await eventPromise
    expect(event.errorKind).toBe('bridge_refused')
  })

  it('enforces the INNER tool scope, not the wrapper (which has none)', async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      // Deliberately omits transactions:read, which the inner tool requires.
      scopes: ['reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Narrow Key',
      mode: 'live',
    } as Awaited<ReturnType<typeof validateApiKey>>)
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', { tool: 'gnubok_list_cash_accounts' }),
    )
    const { isError } = await parsedToolResult(response)

    expect(isError).toBe(true)
    const event = await eventPromise
    expect(event.errorKind).toBe('scope_denied')
    expect(event.tool).toBe('gnubok_list_cash_accounts')
  })

  it('applies the unknown-argument guard to the inner tool', async () => {
    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', {
        tool: 'gnubok_list_skills',
        arguments: { nonexistent_parameter: 1 },
      }),
    )
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toContain('nonexistent_parameter')
  })

  it('is closed to anonymous callers: the pre-auth gate keys on the outer name', async () => {
    // gnubok_call_tool is deliberately absent from PUBLIC_TOOLS, so an
    // unauthenticated client cannot use it as a lever at all. Nothing is lost:
    // all three public tools are in the default catalog already.
    vi.mocked(extractBearerToken).mockReturnValueOnce(null)

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', { tool: 'gnubok_list_skills' }),
    )
    expect(response.status).toBe(401)
  })

  it('reports an unknown inner tool through the normal unknown-tool path', async () => {
    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', { tool: 'gnubok_not_a_real_tool' }),
    )
    const json = (await response.json()) as { error?: { message?: string } }
    expect(json.error?.message).toContain('gnubok_not_a_real_tool')
  })
})

/**
 * gnubok_stage_tool, the write half of the bridge (issue #2800).
 *
 * What these tests defend: the bridge decides only WHICH tools it may name. It
 * grants nothing. Everything a direct call enforces (the target's scope, its
 * argument guard, the test-key block) must still run against the real target,
 * and the two-step gate must hold: gnubok_approve_pending_operation can never
 * ride either bridge, so stage-then-approve cannot both flow through one
 * always-allowed tool.
 */
const stageBridgeTool = tools.find((t) => t.name === 'gnubok_stage_tool')!

const MILEAGE_TRIP_ARGS = {
  trip_date: '2026-01-15',
  distance_km: 42,
  from_location: 'Stockholm',
  to_location: 'Uppsala',
  purpose: 'Kundbesök',
}

function keyWithScopes(scopes: string[], mode: 'live' | 'test' = 'live') {
  vi.mocked(validateApiKey).mockResolvedValueOnce({
    userId: 'user-1',
    companyId: '11111111-1111-4111-8111-111111111111',
    scopes,
    apiKeyId: 'key-1',
    apiKeyName: 'Scoped Key',
    mode,
  } as Awaited<ReturnType<typeof validateApiKey>>)
}

async function listedToolNames(): Promise<string[]> {
  const response = await handleMcpRequest(
    new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  )
  const json = (await response.json()) as { result: { tools: Array<{ name: string }> } }
  return json.result.tools.map((t) => t.name)
}

describe('gnubok_stage_tool registration', () => {
  it('is listed, and is NOT annotated read-only: it stages writes', () => {
    expect(stageBridgeTool).toBeDefined()
    expect(isDefaultCatalogTool(stageBridgeTool)).toBe(true)
    expect(stageBridgeTool.annotations.readOnlyHint).toBe(false)
  })

  it('leaves gnubok_call_tool read-only, so consent given to it keeps its meaning', () => {
    // The reason the write half is a second tool. A client may always-allow
    // the read bridge; that consent must never come to cover staging writes.
    expect(bridgeTool.annotations.readOnlyHint).toBe(true)
  })

  it('has no direct implementation: the dispatcher rewrite is load-bearing', async () => {
    await expect(
      stageBridgeTool.execute({}, 'company-id', 'user-id', {} as never, { type: 'api_key' }),
    ).rejects.toThrow(/no direct implementation/i)
  })
})

describe('gnubok_stage_tool bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('dispatches a search-only staging write to the inner tool, attributed to it', async () => {
    keyWithScopes(['payroll:write'])
    const eventPromise = captureNextToolCalled()

    await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', { tool: 'gnubok_log_mileage_trip', arguments: MILEAGE_TRIP_ARGS }),
    )

    const event = await eventPromise
    expect(event.tool).toBe('gnubok_log_mileage_trip')
    expect(event.errorKind).not.toBe('bridge_refused')
    expect(event.errorKind).not.toBe('scope_denied')
  })

  it('a READ-scoped key cannot stage a write through the bridge: the INNER scope is enforced', async () => {
    // The attack the bridge must not enable. The wrapper has no scope of its
    // own, so if scope were checked on the OUTER name this would pass.
    keyWithScopes(['transactions:read', 'reports:read', 'reconciliation:read', 'payroll:read'])
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', { tool: 'gnubok_log_mileage_trip', arguments: MILEAGE_TRIP_ARGS }),
    )
    const { isError } = await parsedToolResult(response)

    expect(isError).toBe(true)
    const event = await eventPromise
    expect(event.errorKind).toBe('scope_denied')
    expect(event.tool).toBe('gnubok_log_mileage_trip')
    // Refused before execute(): nothing was staged.
    expect(event.latencyMs).toBe(0)
  })

  it('a key with a DIFFERENT write scope is refused too: scopes do not transfer across tools', async () => {
    keyWithScopes(['invoices:write'])
    const eventPromise = captureNextToolCalled()

    await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', { tool: 'gnubok_log_mileage_trip', arguments: MILEAGE_TRIP_ARGS }),
    )

    expect((await eventPromise).errorKind).toBe('scope_denied')
  })

  it('never carries gnubok_approve_pending_operation: the two-step gate holds', async () => {
    // Even for a key that HOLDS the approve scope. The refusal is about the
    // tool not being a staging tool, not about what the key may do.
    keyWithScopes(['pending_operations:approve', 'payroll:write'])
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', {
        tool: 'gnubok_approve_pending_operation',
        arguments: { operation_id: 'op-1' },
      }),
    )
    const { isError } = await parsedToolResult(response)

    expect(isError).toBe(true)
    const event = await eventPromise
    expect(event.errorKind).toBe('bridge_refused')
    expect(event.latencyMs).toBe(0)
  })

  it('refuses a write that commits directly, whatever its annotation constant is called', async () => {
    // gnubok_create_transactions wears ANNOTATIONS_STAGED_WRITE yet inserts
    // rows itself. The bridge keys on the declared staged envelope, not on it.
    keyWithScopes(['transactions:write'])
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', { tool: 'gnubok_create_transactions', arguments: {} }),
    )
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toMatch(/commits directly/)
    expect((await eventPromise).errorKind).toBe('bridge_refused')
  })

  it('refuses a LISTED staging write: that tool keeps its own per-tool permission in the client', async () => {
    keyWithScopes(['invoices:write'])
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', { tool: 'gnubok_create_invoice', arguments: {} }),
    )
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toMatch(/call it directly/)
    expect((await eventPromise).errorKind).toBe('bridge_refused')
  })

  it('refuses a read and points at gnubok_call_tool', async () => {
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', { tool: 'gnubok_get_invoice', arguments: {} }),
    )
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toContain('gnubok_call_tool')
    expect((await eventPromise).errorKind).toBe('bridge_refused')
  })

  it('refuses a call with no tool name', async () => {
    const eventPromise = captureNextToolCalled()
    const { isError } = await parsedToolResult(await handleMcpRequest(mcpToolCall('gnubok_stage_tool', {})))
    expect(isError).toBe(true)
    expect((await eventPromise).errorKind).toBe('bridge_refused')
  })

  it('applies the unknown-argument guard to the inner tool', async () => {
    keyWithScopes(['payroll:write'])
    const response = await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', {
        tool: 'gnubok_log_mileage_trip',
        arguments: { ...MILEAGE_TRIP_ARGS, nonexistent_parameter: 1 },
      }),
    )
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toContain('nonexistent_parameter')
  })

  it('a TEST-mode key stages nothing through the bridge: the write block sees the inner tool', async () => {
    // gnubok_update_salary_run has no dry_run to force, so a test key must be
    // blocked outright, exactly as on a direct call.
    keyWithScopes(['payroll:write'], 'test')
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', {
        tool: 'gnubok_update_salary_run',
        arguments: { salary_run_id: '33333333-3333-4333-8333-333333333333', notes: 'x' },
      }),
    )
    const { isError } = await parsedToolResult(response)

    expect(isError).toBe(true)
    const event = await eventPromise
    expect(event.errorKind).toBe('test_key_write_blocked')
    expect(event.tool).toBe('gnubok_update_salary_run')
  })

  it('is closed to anonymous callers', async () => {
    vi.mocked(extractBearerToken).mockReturnValueOnce(null)
    const response = await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', { tool: 'gnubok_log_mileage_trip', arguments: MILEAGE_TRIP_ARGS }),
    )
    expect(response.status).toBe(401)
  })

  it('reports an unknown inner tool through the normal unknown-tool path', async () => {
    const response = await handleMcpRequest(
      mcpToolCall('gnubok_stage_tool', { tool: 'gnubok_not_a_real_tool' }),
    )
    const json = (await response.json()) as { error?: { message?: string } }
    expect(json.error?.message).toContain('gnubok_not_a_real_tool')
  })

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'a tool named "%s" is not mistaken for a bridge (the lookup is on caller input)',
    async (name) => {
      // An object-literal lookup would match inherited keys and treat this as
      // a bridged call, forwarding the inner tool below. A Map does not.
      keyWithScopes(['payroll:write'])
      const response = await handleMcpRequest(
        mcpToolCall(name, { tool: 'gnubok_log_mileage_trip', arguments: MILEAGE_TRIP_ARGS }),
      )
      const json = (await response.json()) as { error?: { message?: string } }
      expect(json.error?.message).toContain(`Unknown tool: "${name}"`)
    },
  )
})

describe('gnubok_stage_tool in tools/list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('is hidden from a key that could stage nothing through it', async () => {
    // Unscoped itself, so without this a read-only key would be shown a tool
    // whose every call is scope-denied: listed but unusable.
    keyWithScopes(['transactions:read', 'reports:read'])
    const names = await listedToolNames()
    expect(names).toContain('gnubok_call_tool')
    expect(names).not.toContain('gnubok_stage_tool')
  })

  it('is shown to a key holding a scope one of its targets needs', async () => {
    keyWithScopes(['reconciliation:write'])
    expect(await listedToolNames()).toContain('gnubok_stage_tool')
  })
})

// The briefing's callable flags (feedback seq 372962) are only as honest as
// the scopes it sees: the dispatcher must hand it the key's scopes through the
// same private marker gnubok_search_tools gets. Otherwise fail-closed reports
// every scoped tool as blocked_by scope, for every key.
describe('dispatcher injects __keyScopes into gnubok_get_agent_briefing', () => {
  beforeEach(() => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['agent:read', 'reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Live Key',
      mode: 'live',
    } as never)
  })

  it('passes the validated key scopes as __keyScopes on a direct call', async () => {
    const briefing = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const spy = vi.spyOn(briefing, 'execute').mockResolvedValue({ stubbed: true })
    try {
      const response = await handleMcpRequest(mcpToolCall('gnubok_get_agent_briefing'))
      const { isError } = await parsedToolResult(response)
      expect(isError).toBe(false)
      expect(spy).toHaveBeenCalledTimes(1)
      const args = spy.mock.calls[0][0] as Record<string, unknown>
      expect(args.__keyScopes).toEqual(['agent:read', 'reports:read'])
    } finally {
      spy.mockRestore()
    }
  })
  it('routes a bridged read to the API key default company when company_id is omitted', async () => {
    // Easy Online Stores brief 2026-09-16, F6: a bridged gnubok_sie_import_status
    // without company_id reached Postgres as uuid "undefined". The company
    // half was never the bug (the dispatcher resolves the key default before
    // execute); this pins that so the tool-side fix cannot be mistaken for it.
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', { tool: 'gnubok_sie_import_status', arguments: {} }),
    )
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(false)
    expect(payload).toMatchObject({ kind: 'list', count: 0 })
    const event = await eventPromise
    expect(event.tool).toBe('gnubok_sie_import_status')
    expect((event as unknown as { companyId: string }).companyId).toBe('11111111-1111-4111-8111-111111111111')
  })
})
