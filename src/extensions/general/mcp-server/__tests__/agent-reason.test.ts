/**
 * The agent's reason on a staged write (lib/pending-operations/agent-reason.ts):
 * every staging tool takes an optional `reason`, added where the tool list is
 * assembled, and every door that calls a tool splits it off before the
 * tool's own validation runs. The staging helper stores it on the pending
 * operation, so the approver sees it and the receipt can copy it.
 *
 * Driven through handleMcpRequest, so the unknown-argument guard, the bridge
 * rewrite and the real staging insert all run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { AGENT_REASON_PROPERTY, MAX_AGENT_REASON_CHARS, currentAgentReason } from '@/lib/pending-operations/agent-reason'

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

import { handleMcpRequest, isDefaultCatalogTool, isStagingTool, STAGE_BRIDGE_TARGETS, tools } from '../server'
import { TOOL_SCOPE_MAP, createServiceClientNoCookies, validateApiKey } from '@/lib/auth/api-keys'
import { createServiceClient } from '@/lib/supabase/server'
import { createTableMockSupabase } from '@/tests/helpers'

/**
 * Every table answers nothing, the membership check an owner, and a staging
 * insert the row it was given (or, with refuseAgentReason, PostgREST's
 * refusal of a column it does not know yet).
 */
const db = { refuseAgentReason: false, mock: createTableMockSupabase() }

function freshDb() {
  db.refuseAgentReason = false
  db.mock = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' } },
    pending_operations: (calls) => {
      const insert = calls.find((c) => c.method === 'insert')
      if (!insert) return calls.some((c) => c.method === 'single' || c.method === 'maybeSingle') ? { data: null } : { data: [] }
      const row = insert.args[0] as Record<string, unknown>
      if (db.refuseAgentReason && 'agent_reason' in row) {
        return { error: { code: 'PGRST204', message: "Could not find the 'agent_reason' column of 'pending_operations' in the schema cache" } }
      }
      return { data: { id: 'op-1', created_at: '2026-10-28T10:00:00Z', ...row } }
    },
  })
  vi.mocked(createServiceClientNoCookies).mockReturnValue(db.mock.supabase as never)
  vi.mocked(createServiceClient).mockReturnValue(db.mock.supabase as never)
}

function keyWithScopes(scopes: string[]) {
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    scopes,
    apiKeyId: 'key-1',
    apiKeyName: 'Live Key',
    mode: 'live',
  } as Awaited<ReturnType<typeof validateApiKey>>)
}

function rpc(method: string, params: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function callTool(name: string, args: Record<string, unknown>) {
  const response = await handleMcpRequest(rpc('tools/call', { name, arguments: args }))
  const json = (await response.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }
  return { isError: json.result.isError === true, payload: JSON.parse(json.result.content[0].text) as Record<string, unknown> }
}

const stagingInserts = () =>
  db.mock.payloads('pending_operations', 'insert').map((payload) => ({ payload: payload as Record<string, unknown> }))

/** What a spied tool saw: its arguments and the reason in its call's context. */
function spyOnStaging(name: string) {
  const tool = tools.find((t) => t.name === name)!
  const seen: Array<{ args: Record<string, unknown>; reason: string | null }> = []
  const spy = vi.spyOn(tool, 'execute').mockImplementation(async (args) => {
    seen.push({ args, reason: currentAgentReason() })
    return { staged: true, operation_id: 'op-1', risk_level: 'low', actor: { type: 'api_key' }, message: 'staged', preview: {} }
  })
  return { tool, seen, spy }
}

const REASON = 'Acme AB is on three supplier invoices in the inbox and not in the supplier register yet.'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  freshDb()
})

describe('registration', () => {
  const staging = tools.filter(isStagingTool)

  it('gives every staging tool the reason, once, as the one shared property', () => {
    expect(staging.length).toBeGreaterThan(50)
    for (const tool of staging) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>
      expect(tool.agentReason, tool.name).toBeDefined()
      if (tool.agentReason === 'own') {
        expect(properties.reason, tool.name).not.toBe(AGENT_REASON_PROPERTY)
        continue
      }
      expect(tool.agentReason, tool.name).toBe('added')
      expect(properties.reason, tool.name).toBe(AGENT_REASON_PROPERTY)
      // Optional: never required.
      expect((tool.inputSchema.required as string[] | undefined) ?? [], tool.name).not.toContain('reason')
    }
  })

  it("leaves the tools whose own input already has a reason to their own: the list is a choice, not an accident", () => {
    expect(staging.filter((t) => t.agentReason === 'own').map((t) => t.name).sort()).toEqual([
      'gnubok_credit_invoice',
      'gnubok_mark_no_document_required',
      'gnubok_reverse_journal_entry',
      'gnubok_tag_journal_lines',
      'gnubok_undo_sie_import',
    ])
  })

  it('adds nothing to a tool that does not stage', () => {
    for (const tool of tools.filter((t) => !isStagingTool(t))) {
      expect(tool.agentReason, tool.name).toBeUndefined()
      expect((tool.inputSchema.properties as Record<string, unknown> | undefined)?.reason, tool.name).not.toBe(AGENT_REASON_PROPERTY)
    }
  })

  it('lists the reason in tools/list with what to write', async () => {
    keyWithScopes(['suppliers:write'])
    const response = await handleMcpRequest(rpc('tools/list', {}))
    const json = (await response.json()) as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } }
    const listed = json.result.tools.find((t) => t.name === 'gnubok_create_supplier')!
    expect(listed.inputSchema.properties.reason).toEqual({
      type: 'string',
      description: 'Why you propose this: the evidence and the pattern you followed.',
    })
  })
})

describe('a direct call to a staging tool', () => {
  beforeEach(() => keyWithScopes(['suppliers:write', 'suppliers:read']))

  it('stores the reason, trimmed, on the pending operation and keeps it out of the staged params', async () => {
    const { isError, payload } = await callTool('gnubok_create_supplier', { name: 'Acme AB', reason: `  ${REASON}  ` })
    expect(isError).toBe(false)
    expect(payload.staged).toBe(true)
    const [insert] = stagingInserts()
    expect(insert.payload).toMatchObject({ operation_type: 'create_supplier', agent_reason: REASON })
    expect(insert.payload.params).not.toHaveProperty('reason')
    expect(JSON.stringify(insert.payload.preview_data)).not.toContain(REASON)
  })

  it('names no agent_reason column when the call gives none, or an empty one', async () => {
    await callTool('gnubok_create_supplier', { name: 'Acme AB' })
    await callTool('gnubok_create_supplier', { name: 'Acme AB', reason: '   ' })
    expect(stagingInserts()).toHaveLength(2)
    for (const insert of stagingInserts()) expect(insert.payload).not.toHaveProperty('agent_reason')
  })

  it('cuts a reason longer than the limit at a word boundary instead of refusing the write', async () => {
    const long = Array.from({ length: 150 }, (_, i) => `evidence${i}`).join(' ')
    const { isError } = await callTool('gnubok_create_supplier', { name: 'Acme AB', reason: long })
    expect(isError).toBe(false)
    const stored = stagingInserts()[0].payload.agent_reason as string
    expect(Array.from(stored).length).toBeLessThanOrEqual(MAX_AGENT_REASON_CHARS)
    expect(long.startsWith(stored.slice(0, -1))).toBe(true)
  })

  it('still stages, without the reason, while the agent_reason column is not there yet', async () => {
    db.refuseAgentReason = true
    const { isError, payload } = await callTool('gnubok_create_supplier', { name: 'Acme AB', reason: REASON })
    expect(isError).toBe(false)
    expect(payload.operation_id).toBe('op-1')
    const inserts = stagingInserts()
    expect(inserts).toHaveLength(2)
    expect(inserts[0].payload.agent_reason).toBe(REASON)
    expect(inserts[1].payload).not.toHaveProperty('agent_reason')
  })

  it("hands the tool its arguments without the reason, and the reason through the call's context", async () => {
    const { seen, spy } = spyOnStaging('gnubok_create_supplier')
    try {
      await callTool('gnubok_create_supplier', { name: 'Acme AB', reason: REASON })
      await callTool('gnubok_create_supplier', { name: 'Acme AB' })
    } finally {
      spy.mockRestore()
    }
    expect(seen).toEqual([
      { args: { name: 'Acme AB' }, reason: REASON },
      { args: { name: 'Acme AB' }, reason: null },
    ])
  })

  it('still refuses reason on a tool that does not stage', async () => {
    const { isError, payload } = await callTool('gnubok_list_suppliers', { reason: REASON })
    expect(isError).toBe(true)
    expect((payload.error as { message_en: string }).message_en).toContain('Unknown parameter "reason"')
  })
})

describe('a tool whose own input has a reason', () => {
  it('keeps it as its own argument and takes it as the agent reason too', async () => {
    keyWithScopes([TOOL_SCOPE_MAP.gnubok_reverse_journal_entry!])
    const { seen, spy } = spyOnStaging('gnubok_reverse_journal_entry')
    try {
      await callTool('gnubok_reverse_journal_entry', { entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reason: ' Dubbelbokad ' })
    } finally {
      spy.mockRestore()
    }
    expect(seen).toEqual([{ args: { entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reason: ' Dubbelbokad ' }, reason: 'Dubbelbokad' }])
  })
})

describe('the stage_tool bridge', () => {
  const target = STAGE_BRIDGE_TARGETS.find((t) => t.agentReason === 'added')!

  it('carries the reason inside arguments to the tool, split off as on a direct call', async () => {
    expect(isDefaultCatalogTool(target)).toBe(false)
    keyWithScopes([TOOL_SCOPE_MAP[target.name]!].filter(Boolean))
    const { seen, spy } = spyOnStaging(target.name)
    try {
      const { isError } = await callTool('gnubok_stage_tool', { tool: target.name, arguments: { reason: REASON } })
      expect(isError).toBe(false)
    } finally {
      spy.mockRestore()
    }
    expect(seen).toEqual([{ args: {}, reason: REASON }])
  })
})
