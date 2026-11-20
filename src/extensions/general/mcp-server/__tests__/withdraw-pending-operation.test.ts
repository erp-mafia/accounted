/**
 * gnubok_withdraw_pending_operation: the connection that staged a proposal
 * takes it back (crm#1725, crm#1817).
 *
 * Two agents reported the same gap: a key without pending_operations:approve
 * staged a duplicate or a wrong proposal and could not remove it, so the
 * mistaken card waited next to the corrected one and the wrong one was
 * approved. The tool is search-only (tools/list has no room), has no scope of
 * its own (ownership is the gate) and rides the stage bridge, so the same key
 * that staged can reach it from a client that only knows tools/list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  extractBearerToken: vi.fn().mockReturnValue('test-token'),
  validateApiKey: vi.fn(),
  createServiceClientNoCookies: vi.fn(),
}))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))
const audit = vi.hoisted(() => ({ append: vi.fn(async (..._a: unknown[]) => 'event-1') }))
vi.mock('@/lib/processing-history/append', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/processing-history/append')>()),
  appendProcessingHistory: (...args: unknown[]) => audit.append(...args),
}))

import { validateApiKey, createServiceClientNoCookies, TOOL_SCOPE_MAP, UNSCOPED_TOOLS } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { operationRowDouble } from '@/lib/pending-operations/__tests__/operation-row-double'
import { isReadOnlyTool as chatReadOnlyTool } from '@/lib/agent/chat/read-only-tools'
import { WITHDRAWN_LEAD } from '@/lib/pending-operations/withdraw'
import { handleMcpRequest, isDefaultCatalogTool, isStagingTool, tools, WITHDRAW_TOOL_NAME } from '../server'
import { isOperationScopedTool } from '../company-routing'

type Row = Record<string, unknown>

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OP_ID = '22222222-2222-4222-8222-222222222222'
const STAGER_KEY = 'key-stager'
/** What a staging connection holds: a write scope, and no approve. */
const STAGING_SCOPES = ['bookkeeping:write', 'pending_operations:read']

const withdrawTool = tools.find((t) => t.name === WITHDRAW_TOOL_NAME)!

function stagedRow(overrides: Row = {}): Row {
  return {
    id: OP_ID,
    company_id: COMPANY_ID,
    status: 'pending',
    user_id: 'user-1',
    actor_type: 'api_key',
    actor_id: STAGER_KEY,
    operation_type: 'create_voucher',
    risk_level: 'high',
    result_data: null,
    ...overrides,
  }
}

/** The company's one staged operation, and an owner membership, behind the service client. */
function database(initial: Row | null) {
  const { state, resolver } = operationRowDouble(initial)
  const mock = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    pending_operations: resolver,
  })
  vi.mocked(createServiceClientNoCookies).mockReturnValue(mock.supabase as never)
  return { ...mock, state }
}

function connection(apiKeyId: string, scopes: string[] = STAGING_SCOPES) {
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    scopes,
    apiKeyId,
    apiKeyName: 'Agenten',
    mode: 'live',
  } as never)
}

async function call(name: string, args: Record<string, unknown>) {
  let errorKind: string | null = null
  const off = eventBus.on('mcp.tool_called', (payload) => {
    errorKind = (payload as unknown as { errorKind: string | null }).errorKind
  })
  const response = await handleMcpRequest(
    new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  )
  off()
  const json = (await response.json()) as { result?: { isError?: boolean; content: { text: string }[] }; error?: unknown }
  const text = json.result?.content.map((c) => c.text).join('\n') ?? JSON.stringify(json.error)
  return { isError: json.result?.isError === true || json.error !== undefined, text, errorKind }
}

const viaBridge = (bridge: 'gnubok_stage_tool' | 'gnubok_call_tool', args: Record<string, unknown>) =>
  call(bridge, { tool: WITHDRAW_TOOL_NAME, arguments: args })

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  connection(STAGER_KEY)
})

describe('gnubok_withdraw_pending_operation: registration', () => {
  it('is search-only, a direct idempotent write, and takes no scope: ownership is the gate', () => {
    expect(withdrawTool).toBeDefined()
    expect(isDefaultCatalogTool(withdrawTool)).toBe(false)
    expect(isStagingTool(withdrawTool)).toBe(false)
    expect(withdrawTool.annotations.readOnlyHint).not.toBe(true)
    expect(withdrawTool.annotations.idempotentHint).toBe(true)
    expect(UNSCOPED_TOOLS.has(WITHDRAW_TOOL_NAME)).toBe(true)
    expect(TOOL_SCOPE_MAP[WITHDRAW_TOOL_NAME]).toBeUndefined()
  })

  it('follows the operation to its company, as approve and reject do', () => {
    expect(isOperationScopedTool(WITHDRAW_TOOL_NAME)).toBe(true)
  })

  it('is not handed to a read-only member\'s assistant turn as a read', () => {
    expect(chatReadOnlyTool(WITHDRAW_TOOL_NAME)).toBe(false)
    expect(chatReadOnlyTool('gnubok_feedback')).toBe(true)
  })
})

describe('gnubok_withdraw_pending_operation: through the dispatcher', () => {
  it('a connection without pending_operations:approve withdraws its own pending proposal', async () => {
    const { state } = database(stagedRow())

    const result = await call(WITHDRAW_TOOL_NAME, { operation_id: OP_ID, reason: 'dubblett' })

    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('"status": "withdrawn"')
    expect(state.row).toMatchObject({
      status: 'rejected',
      rejection_category: 'superseded',
      rejection_reason: `${WITHDRAWN_LEAD}: dubblett`,
      result_data: { withdrawn: true, rejected_by: 'user-1', rejected_via: 'api_key', actor_id: STAGER_KEY },
    })
  })

  it('writes one audit row naming the withdrawing connection', async () => {
    database(stagedRow())

    await call(WITHDRAW_TOOL_NAME, { operation_id: OP_ID })

    expect(audit.append).toHaveBeenCalledTimes(1)
    expect(audit.append.mock.calls[0][0]).toMatchObject({
      companyId: COMPANY_ID,
      aggregateId: OP_ID,
      eventType: 'PendingOperationRejected',
      payload: { channel: 'mcp', withdrawn: true, operation_type: 'create_voucher' },
      actor: { type: 'api_key', id: STAGER_KEY, label: 'Agenten' },
    })
  })

  it.each(['gnubok_stage_tool', 'gnubok_call_tool'] as const)(
    'is reachable through %s, for a client that only knows tools/list',
    async (bridge) => {
      const { state } = database(stagedRow())

      const result = await viaBridge(bridge, { operation_id: OP_ID })

      expect(result.errorKind).not.toBe('bridge_refused')
      expect(result.isError, result.text).toBe(false)
      expect(state.row?.status).toBe('rejected')
    },
  )

  it('the bridge still refuses reject for the same key: withdrawing is not rejecting', async () => {
    const { state } = database(stagedRow())

    const result = await call('gnubok_stage_tool', {
      tool: 'gnubok_reject_pending_operation',
      arguments: { operation_id: OP_ID },
    })

    expect(result.errorKind).toBe('bridge_refused')
    // The refusal now names the way that is open to it.
    expect(result.text).toContain('gnubok_withdraw_pending_operation')
    expect(state.row?.status).toBe('pending')
  })

  it.each([
    ['another connection', stagedRow({ actor_id: 'key-other' })],
    ['a person in the app', stagedRow({ actor_type: 'user', actor_id: null })],
    ['another user\'s connection', stagedRow({ user_id: 'user-2' })],
  ])('refuses a proposal staged by %s and leaves it pending', async (_who, row) => {
    const { state } = database(row)

    const result = await call(WITHDRAW_TOOL_NAME, { operation_id: OP_ID })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('FORBIDDEN')
    expect(result.text).toContain('/pending')
    expect(state.row?.status).toBe('pending')
    expect(state.updates).toEqual([])
    expect(audit.append).not.toHaveBeenCalled()
  })

  it('holding pending_operations:approve does not make another stager\'s proposal withdrawable', async () => {
    connection('key-approver', ['pending_operations:approve'])
    const { state } = database(stagedRow())

    const result = await call(WITHDRAW_TOOL_NAME, { operation_id: OP_ID })

    expect(result.text).toContain('FORBIDDEN')
    expect(state.row?.status).toBe('pending')
  })

  it.each([
    ['committing', /being approved right now/],
    ['committed', /already committed/],
    ['failed_partial', /already resolved as failed_partial/],
  ])('answers CONFLICT for an own operation that is %s, and writes nothing', async (status, message) => {
    const { state } = database(stagedRow({ status }))

    const result = await call(WITHDRAW_TOOL_NAME, { operation_id: OP_ID })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('CONFLICT')
    expect(result.text).toMatch(message)
    expect(state.row?.status).toBe(status)
    expect(state.updates).toEqual([])
  })

  it('is idempotent: the second call answers already_withdrawn and writes nothing more', async () => {
    const { state } = database(stagedRow())

    const first = await call(WITHDRAW_TOOL_NAME, { operation_id: OP_ID })
    const second = await call(WITHDRAW_TOOL_NAME, { operation_id: OP_ID })

    expect(first.text).not.toContain('already_withdrawn')
    expect(second.isError, second.text).toBe(false)
    expect(second.text).toContain('"already_withdrawn": true')
    expect(state.updates).toHaveLength(1)
    expect(audit.append).toHaveBeenCalledTimes(1)
  })

  it('answers NOT_FOUND for an id that names no operation', async () => {
    database(null)

    const result = await call(WITHDRAW_TOOL_NAME, { operation_id: OP_ID })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('NOT_FOUND')
  })
})

describe('gnubok_withdraw_pending_operation: outside a key', () => {
  it('a caller that is not an API key or OAuth connection staged nothing it could withdraw', async () => {
    const { supabase, state } = database(stagedRow({ actor_type: 'user', actor_id: null }))

    await expect(
      withdrawTool.execute({ operation_id: OP_ID }, COMPANY_ID, 'user-1', supabase as never, { type: 'user' }),
    ).rejects.toThrow(/not staged by this connection/)
    expect(state.updates).toEqual([])
  })
})
