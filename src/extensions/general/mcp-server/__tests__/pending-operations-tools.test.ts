import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { OAUTH_MCP_KEY_NAME, TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

const commitSpy = vi.fn()

vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => commitSpy(...args),
}))

// Import after mock so the tool registry binds to the mocked module
import { tools } from '../server'

const listTool = tools.find((t) => t.name === 'gnubok_list_pending_operations')!
const approveTool = tools.find((t) => t.name === 'gnubok_approve_pending_operation')!
const rejectTool = tools.find((t) => t.name === 'gnubok_reject_pending_operation')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('pending_operations MCP tools: registration', () => {
  it('all three tools are registered', () => {
    expect(listTool).toBeDefined()
    expect(approveTool).toBeDefined()
    expect(rejectTool).toBeDefined()
  })

  it('list is gated by pending_operations:read', () => {
    expect(TOOL_SCOPE_MAP['gnubok_list_pending_operations']).toBe('pending_operations:read')
  })

  it('approve and reject are gated by pending_operations:approve', () => {
    expect(TOOL_SCOPE_MAP['gnubok_approve_pending_operation']).toBe('pending_operations:approve')
    expect(TOOL_SCOPE_MAP['gnubok_reject_pending_operation']).toBe('pending_operations:approve')
  })

  it('input schemas have additionalProperties: false', () => {
    for (const t of [listTool, approveTool, rejectTool]) {
      expect((t.inputSchema as Record<string, unknown>).additionalProperties).toBe(false)
    }
  })
})

describe('gnubok_list_pending_operations', () => {
  it('returns operations with pagination envelope', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const ops = [
      { id: 'op-1', operation_type: 'create_invoice', status: 'pending', risk_level: 'medium', created_at: '2026-05-01T00:00:00Z' },
      { id: 'op-2', operation_type: 'create_voucher', status: 'pending', risk_level: 'high', created_at: '2026-05-02T00:00:00Z' },
    ]
    enqueue({ data: ops, error: null, count: 2 })

    const result = (await listTool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      operations: Array<{ id: string }>
      count: number
      total_count: number
      has_more: boolean
    }

    expect(result.operations).toHaveLength(2)
    expect(result.count).toBe(2)
    expect(result.total_count).toBe(2)
    expect(result.has_more).toBe(false)
  })

  it('carries task_state on every row, as the v1 endpoints answer it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'op-1', status: 'pending', rejection_category: null },
        { id: 'op-2', status: 'committed', rejection_category: null },
        { id: 'op-3', status: 'rejected', rejection_category: 'failed' },
        { id: 'op-4', status: 'rejected', rejection_category: 'expired' },
      ],
      error: null,
      count: 4,
    })

    const result = (await listTool.execute({ status: 'pending' }, 'company-1', 'user-1', supabase as never, {
      type: 'api_key',
    })) as { operations: Array<{ id: string; task_state: string }> }

    expect(result.operations.map((op) => op.task_state)).toEqual(['working', 'completed', 'failed', 'cancelled'])
  })

  it('signals has_more + next_offset when more rows exist beyond the page', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-1' }], error: null, count: 50 })

    const result = (await listTool.execute(
      { limit: 1, offset: 0 },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as { has_more: boolean; next_offset?: number }

    expect(result.has_more).toBe(true)
    expect(result.next_offset).toBe(1)
  })

  it('names who staged each operation with the person it acted for, never the raw user id', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'op-1', status: 'pending', actor_type: 'api_key', actor_label: 'Claude (Anthropic)', user_id: 'user-1' },
        { id: 'op-2', status: 'pending', actor_type: 'api_key', actor_label: OAUTH_MCP_KEY_NAME, user_id: 'user-gone' },
        { id: 'op-3', status: 'pending', actor_type: 'service_account', actor_label: 'Lager', user_id: 'user-1' },
      ],
      error: null,
      count: 3,
    })
    enqueue({ data: [{ id: 'user-1', email: 'jonas@example.com', full_name: 'Jonas Ek' }], error: null })

    const result = (await listTool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      operations: Array<Record<string, unknown>>
    }

    expect(result.operations.map((op) => op.proposed_by)).toEqual(['Claude åt Jonas Ek', 'AI-anslutning', 'Tjänstekontot Lager åt Jonas Ek'])
    expect(result.operations.every((op) => !('user_id' in op))).toBe(true)
    expect(findCalls('profiles', 'in')[0]).toEqual(['id', ['user-1', 'user-gone']])
  })

  it("returns each operation's agent_reason, why its stager proposes it", async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'op-1', status: 'pending', agent_reason: 'Telia every month on 6212.' },
        { id: 'op-2', status: 'pending', agent_reason: null },
      ],
      error: null,
      count: 2,
    })

    const result = (await listTool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      operations: Array<{ id: string; agent_reason: string | null }>
    }

    expect(result.operations.map((op) => op.agent_reason)).toEqual(['Telia every month on 6212.', null])
    expect(String(findCalls('pending_operations', 'select')[0]?.[0])).toContain('agent_reason')
    expect(String(findCalls('pending_operations', 'select')[0]?.[0])).not.toContain('params')
  })

  it('lists without agent_reason while that column is not there yet', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '42703', message: 'column pending_operations.agent_reason does not exist' }, count: null })
    enqueue({ data: [{ id: 'op-1', status: 'pending' }], error: null, count: 1 })

    const result = (await listTool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      operations: Array<{ id: string }>
    }

    expect(result.operations.map((op) => op.id)).toEqual(['op-1'])
    const selects = findCalls('pending_operations', 'select').map((args) => String(args[0]))
    expect(selects).toHaveLength(2)
    expect(selects[1]).not.toContain('agent_reason')
  })

  // Issue #3408: approve is never pre-ticked on consent, so the default
  // connection lacks it; the widget reads can_approve to hide its buttons.
  it('says whether the calling key can approve or reject', async () => {
    const run = async (args: Record<string, unknown>) => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: [{ id: 'op-1' }], error: null, count: 1 })
      return (await listTool.execute(args, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
        can_approve?: boolean
      }
    }

    expect((await run({ __keyScopes: ['pending_operations:read', 'transactions:write'] })).can_approve).toBe(false)
    expect(
      (await run({ __keyScopes: ['pending_operations:read', 'pending_operations:approve'] })).can_approve,
    ).toBe(true)
    // Scopes unknown (not injected): no claim either way, the widget keeps its buttons.
    expect(await run({})).not.toHaveProperty('can_approve')
  })
})

describe('gnubok_approve_pending_operation', () => {
  it('fetches the op then delegates to commitPendingOperation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const op = { id: 'op-1', operation_type: 'create_invoice', company_id: 'company-1', status: 'pending', risk_level: 'medium', params: {} }
    enqueue({ data: op, error: null }) // fetch
    commitSpy.mockResolvedValue({ status: 'committed', data: { invoice_id: 'inv-1' } })

    const result = (await approveTool.execute(
      { operation_id: 'op-1' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as { status: string; operation_id: string; data?: { invoice_id: string } }

    expect(commitSpy).toHaveBeenCalledTimes(1)
    expect(commitSpy.mock.calls[0][3]).toMatchObject({ id: 'op-1' })
    // commit options always include commitMethod; userEmail is added when
    // the supabase mock supports auth.admin.getUserById (it doesn't here, so
    // the resolution silently fails and we fall back to just commitMethod).
    // An api_key actor records 'api_key' in the immutable layer: MCP-relayed
    // acknowledgment, not a first-party human session (vision §8 P0-1).
    // The actor option drives the runWithActor() scope inside
    // commitPendingOperation so EVERY journal commit in the op is attributed
    // (committed_actor_* + audit_log, migration 20260619120000).
    expect(commitSpy.mock.calls[0][4]).toMatchObject({
      commitMethod: 'api_key',
      actor: { type: 'api_key' },
    })
    expect(result.status).toBe('committed')
    expect(result.operation_id).toBe('op-1')
    expect(result.data?.invoice_id).toBe('inv-1')
  })

  // handleMcpRequest sets actor.type='api_key' for ALL MCP traffic (the OAuth
  // connector's access_token is a minted API key); the OAuth case is told
  // apart by the key's reserved name, in the test below.
  it.each([
    { actorType: 'api_key', expected: 'api_key' },
    { actorType: 'user', expected: 'user_accept' },
  ] as const)(
    'records commit_method=$expected when the approving actor is $actorType',
    async ({ actorType, expected }) => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const op = { id: 'op-1', operation_type: 'create_invoice', company_id: 'company-1', status: 'pending', risk_level: 'medium', params: {} }
      enqueue({ data: op, error: null }) // fetch
      commitSpy.mockResolvedValue({ status: 'committed' })

      await approveTool.execute(
        { operation_id: 'op-1' },
        'company-1',
        'user-1',
        supabase as never,
        { type: actorType }
      )

      expect(commitSpy.mock.calls[0][4]).toMatchObject({
        commitMethod: expected,
        actor: { type: actorType },
      })
    }
  )

  // Who decided: a key minted by the OAuth sign-in commits as mcp_oauth, not
  // api_key. handleMcpRequest marks it (oauthKey) from the reserved name
  // OAUTH_MCP_KEY_NAME and then renames the label to the client's display
  // name, so the label here is 'Claude (Anthropic)', not the reserved name
  // (oauth-commit-actor.test.ts covers that rename end to end). The key's
  // ceiling travels with it: the label must not lift the unattended limit.
  it('labels an OAuth connector approval mcp_oauth and keeps its ceiling', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const op = { id: 'op-1', operation_type: 'create_invoice', company_id: 'company-1', status: 'pending', risk_level: 'medium', params: {} }
    enqueue({ data: op, error: null }) // fetch
    commitSpy.mockResolvedValue({ status: 'committed' })

    await approveTool.execute(
      { operation_id: 'op-1' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key', label: 'Claude (Anthropic)', oauthKey: true, unattendedCommitLimit: 500 }
    )

    expect(commitSpy.mock.calls[0][4]).toMatchObject({
      commitMethod: 'api_key',
      actor: { type: 'mcp_oauth', label: 'Claude (Anthropic)', unattendedCommitLimit: 500 },
    })
  })

  // The reserved name alone, without the mark handleMcpRequest sets, is a
  // display string: the stamp no longer reads it.
  it('does not classify an approval by its label', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const op = { id: 'op-1', operation_type: 'create_invoice', company_id: 'company-1', status: 'pending', risk_level: 'medium', params: {} }
    enqueue({ data: op, error: null }) // fetch
    commitSpy.mockResolvedValue({ status: 'committed' })

    await approveTool.execute(
      { operation_id: 'op-1' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key', label: OAUTH_MCP_KEY_NAME }
    )

    expect(commitSpy.mock.calls[0][4]).toMatchObject({ actor: { type: 'api_key', label: OAUTH_MCP_KEY_NAME } })
  })

  it('keeps a hand-made API key as api_key', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const op = { id: 'op-1', operation_type: 'create_invoice', company_id: 'company-1', status: 'pending', risk_level: 'medium', params: {} }
    enqueue({ data: op, error: null }) // fetch
    commitSpy.mockResolvedValue({ status: 'committed' })

    await approveTool.execute(
      { operation_id: 'op-1' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key', label: 'Bokföringsrobot' }
    )

    expect(commitSpy.mock.calls[0][4]).toMatchObject({
      commitMethod: 'api_key',
      actor: { type: 'api_key', label: 'Bokföringsrobot' },
    })
  })

  it('refuses to approve a risk_level=high op without confirmed=true', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const op = {
      id: 'op-1',
      operation_type: 'create_voucher',
      company_id: 'company-1',
      status: 'pending',
      risk_level: 'high',
      params: {},
    }
    enqueue({ data: op, error: null }) // fetch

    await expect(
      approveTool.execute(
        { operation_id: 'op-1' },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' }
      )
    ).rejects.toThrow(/confirmed=true/i)
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it('approves a risk_level=high op when confirmed=true is supplied', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const op = {
      id: 'op-1',
      operation_type: 'create_voucher',
      company_id: 'company-1',
      status: 'pending',
      risk_level: 'high',
      params: {},
    }
    enqueue({ data: op, error: null }) // fetch
    commitSpy.mockResolvedValue({ status: 'committed' })

    const result = (await approveTool.execute(
      { operation_id: 'op-1', confirmed: true },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as { status: string; operation_id: string }

    expect(commitSpy).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('committed')
  })

  it('refuses a collections handover or escalation even with confirmed=true: only a person approves it, in Accounted', async () => {
    for (const [operation_type, params] of [
      ['open_collection_case', { invoice_id: 'inv-1', expected_remaining: 100 }],
      ['collection_case_action', { invoice_id: 'inv-1', action: 'approve_step' }],
      ['collections_daily_batch', { batch_date: '2026-10-07', items: [], excluded: [] }],
    ] as const) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: 'op-1', operation_type, company_id: 'company-1', status: 'pending', risk_level: 'high', params }, error: null })
      await expect(
        approveTool.execute({ operation_id: 'op-1', confirmed: true }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
      ).rejects.toMatchObject({ code: 'COLLECTION_ATTESTATION_WEB_ONLY' })
    }
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it('refuses a rule for automatic booking with GRANT_NEEDS_PERSON, for every key and even with confirmed=true', async () => {
    for (const actor of [
      { type: 'api_key' as const },
      { type: 'api_key' as const, oauthKey: true },
      { type: 'api_key' as const, serviceAccountId: 'sa-1' },
    ]) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({
        data: { id: 'op-1', operation_type: 'create_grant', company_id: 'company-1', status: 'pending', risk_level: 'high', params: { counterparty_key: 'spotify' } },
        error: null,
      })
      const refusal = approveTool.execute({ operation_id: 'op-1', confirmed: true }, 'company-1', 'user-1', supabase as never, actor)
      await expect(refusal).rejects.toMatchObject({ code: 'GRANT_NEEDS_PERSON' })
      await expect(refusal).rejects.toThrow(/Att göra/)
    }
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it('approves a collections action that only serves the case', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'op-1', operation_type: 'collection_case_action', company_id: 'company-1', status: 'pending', risk_level: 'high', params: { invoice_id: 'inv-1', action: 'pause' } },
      error: null,
    })
    commitSpy.mockResolvedValue({ status: 'committed' })
    await approveTool.execute({ operation_id: 'op-1', confirmed: true }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
    expect(commitSpy).toHaveBeenCalledTimes(1)
  })

  it('throws when the operation is not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'not found' } })

    await expect(
      approveTool.execute({ operation_id: 'missing' }, 'company-1', 'user-1', supabase as never)
    ).rejects.toThrow(/not found/i)
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it('surfaces failed status from the executor', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', operation_type: 'create_voucher', company_id: 'company-1', status: 'pending', params: {} }, error: null })
    commitSpy.mockResolvedValue({ status: 'failed', error: 'Period locked', http_status: 423 })

    const result = (await approveTool.execute(
      { operation_id: 'op-1' },
      'company-1',
      'user-1',
      supabase as never
    )) as { status: string; error?: string }

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Period locked')
  })
})

describe('gnubok_reject_pending_operation', () => {
  it('flips status to rejected and never invokes the executor', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-1', status: 'pending', operation_type: 'categorize_transaction', risk_level: 'low' }], error: null }) // fetch
    enqueue({ data: [{ id: 'op-1' }], error: null }) // update CAS: returns rows

    const result = (await rejectTool.execute(
      { operation_id: 'op-1' },
      'company-1',
      'user-1',
      supabase as never
    )) as { status: string; operation_id: string }

    expect(result.status).toBe('rejected')
    expect(result.operation_id).toBe('op-1')
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it('stores the category and reason in the rejection columns, where the dashboard keeps them', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-1', status: 'pending', operation_type: 'categorize_transaction', risk_level: 'low' }], error: null })
    enqueue({ data: [{ id: 'op-1' }], error: null })

    await rejectTool.execute(
      { operation_id: 'op-1', category: 'wrong_category', reason: ' Ska vara 5410 ' },
      'company-1',
      'user-1',
      supabase as never,
    )

    expect(findCalls('pending_operations', 'update')[0]?.[0]).toMatchObject({
      status: 'rejected',
      rejection_category: 'wrong_category',
      rejection_reason: 'Ska vara 5410',
    })
  })

  it('leaves the category empty when the user gave none, and refuses one outside the list', async () => {
    const plain = createQueuedMockSupabase()
    plain.enqueue({ data: [{ id: 'op-1', status: 'pending', operation_type: 'categorize_transaction', risk_level: 'low' }], error: null })
    plain.enqueue({ data: [{ id: 'op-1' }], error: null })
    await rejectTool.execute({ operation_id: 'op-1' }, 'company-1', 'user-1', plain.supabase as never)
    expect(plain.findCalls('pending_operations', 'update')[0]?.[0]).not.toHaveProperty('rejection_category')

    const bad = createQueuedMockSupabase()
    await expect(
      rejectTool.execute({ operation_id: 'op-1', category: 'expired' }, 'company-1', 'user-1', bad.supabase as never),
    ).rejects.toThrow(/category must be one of/)
    expect(bad.findCalls('pending_operations', 'update')).toEqual([])
  })

  it('throws when the CAS update affects 0 rows (concurrent claim)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-1', status: 'pending', operation_type: 'categorize_transaction', risk_level: 'low' }], error: null }) // fetch
    enqueue({ data: [], error: null }) // update CAS: 0 rows (lost race)

    await expect(
      rejectTool.execute({ operation_id: 'op-1' }, 'company-1', 'user-1', supabase as never)
    ).rejects.toThrow(/no longer pending/i)
  })

  it('throws 409-style error if the op is already resolved', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-1', status: 'committed', operation_type: 'x', risk_level: 'low' }], error: null })

    await expect(
      rejectTool.execute({ operation_id: 'op-1' }, 'company-1', 'user-1', supabase as never)
    ).rejects.toThrow(/already committed/i)
  })

  it('throws when the op is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [], error: null })

    await expect(
      rejectTool.execute({ operation_id: 'missing' }, 'company-1', 'user-1', supabase as never)
    ).rejects.toThrow(/not found/i)

    // A malformed id fails the read with 22P02: still a plain not found.
    const malformed = createQueuedMockSupabase()
    malformed.enqueue({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } })
    await expect(
      rejectTool.execute({ operation_id: 'not-a-uuid' }, 'company-1', 'user-1', malformed.supabase as never)
    ).rejects.toThrow(/not found/i)
  })

  it('records the agent actor in result_data, as the app rejections now do', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-1', status: 'pending', operation_type: 'x', risk_level: 'low' }], error: null })
    enqueue({ data: [{ id: 'op-1' }], error: null })

    await rejectTool.execute(
      { operation_id: 'op-1', reason: 'fel konto' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key', id: 'key-1' },
    )

    expect(findCalls('pending_operations', 'update')[0]?.[0]).toMatchObject({
      result_data: { rejected_by: 'user-1', rejected_via: 'api_key', actor_id: 'key-1', reason: 'fel konto' },
    })
  })

  it("records a service account's key as service_account, as the v1 reject does", async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-1', status: 'pending', operation_type: 'x', risk_level: 'low' }], error: null })
    enqueue({ data: [{ id: 'op-1' }], error: null })

    await rejectTool.execute({ operation_id: 'op-1' }, 'company-1', 'sponsor-1', supabase as never, {
      type: 'api_key',
      id: 'key-sa',
      label: 'Nattlig synk',
      serviceAccountId: 'sa-1',
    })

    expect(findCalls('pending_operations', 'update')[0]?.[0]).toMatchObject({
      result_data: { rejected_by: 'sponsor-1', rejected_via: 'service_account', actor_id: 'key-sa' },
    })
  })
})
