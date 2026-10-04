import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP, keyCanCallTool } from '@/lib/auth/api-keys'

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

  // Founder decision 2026-10-03: rejecting is not approval. A write key may
  // reach reject (for its own proposals); approve stays approve-only.
  it('a write key without approve reaches reject but not approve', () => {
    const writeKey = ['pending_operations:read', 'transactions:write']
    expect(keyCanCallTool('gnubok_reject_pending_operation', writeKey)).toBe(true)
    expect(keyCanCallTool('gnubok_approve_pending_operation', writeKey)).toBe(false)
    expect(keyCanCallTool('gnubok_reject_pending_operation', ['pending_operations:read'])).toBe(false)
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

describe('gnubok_list_pending_operations: can_reject per operation', () => {
  const KEY = 'a1a1a1a1-0000-4000-8000-000000000001'
  const rows = [
    { id: 'own', status: 'pending', actor_type: 'api_key', actor_id: KEY },
    { id: 'other-connection', status: 'pending', actor_type: 'api_key', actor_id: 'b2b2b2b2-0000-4000-8000-000000000002' },
    { id: 'person', status: 'pending', actor_type: 'user', actor_id: null },
    // Already resolved: the reject tool answers CONFLICT, so never rejectable.
    { id: 'own-committed', status: 'committed', actor_type: 'api_key', actor_id: KEY },
  ]
  const run = async (args: Record<string, unknown>) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: rows, error: null, count: rows.length })
    return (await listTool.execute(args, 'company-1', 'user-1', supabase as never, { type: 'api_key', id: KEY })) as {
      can_approve?: boolean
      operations: Array<{ id: string; can_reject?: boolean }>
    }
  }
  const flags = (result: { operations: Array<{ id: string; can_reject?: boolean }> }) =>
    Object.fromEntries(result.operations.map((op) => [op.id, op.can_reject]))

  it('a write key without approve may reject only the rows it staged itself', async () => {
    const result = await run({ __keyScopes: ['pending_operations:read', 'invoices:write'] })
    expect(result.can_approve).toBe(false)
    expect(flags(result)).toEqual({ own: true, 'other-connection': false, person: false, 'own-committed': false })
  })

  it('a key with approve may reject every row', async () => {
    const result = await run({ __keyScopes: ['pending_operations:read', 'pending_operations:approve'] })
    expect(result.can_approve).toBe(true)
    expect(flags(result)).toEqual({ own: true, 'other-connection': true, person: true, 'own-committed': false })
  })

  it('a read-only key may reject none', async () => {
    expect(flags(await run({ __keyScopes: ['pending_operations:read'] }))).toEqual({
      own: false,
      'other-connection': false,
      person: false,
      'own-committed': false,
    })
  })

  it('makes no claim when the scopes are unknown', async () => {
    const result = await run({})
    for (const op of result.operations) expect(op).not.toHaveProperty('can_reject')
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

  // No 'mcp_oauth' row: handleMcpRequest hardcodes actor.type='api_key' for
  // ALL MCP traffic (the OAuth connector's access_token is a minted API key),
  // so 'api_key' is the only agent-credential value a live request produces.
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
    enqueue({ data: { id: 'op-1', status: 'pending' }, error: null }) // fetch
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

  it('throws when the CAS update affects 0 rows (concurrent claim)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', status: 'pending' }, error: null }) // fetch
    enqueue({ data: [], error: null }) // update CAS: 0 rows (lost race)

    await expect(
      rejectTool.execute({ operation_id: 'op-1' }, 'company-1', 'user-1', supabase as never)
    ).rejects.toThrow(/no longer pending/i)
  })

  it('throws 409-style error if the op is already resolved', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', status: 'committed' }, error: null })

    await expect(
      rejectTool.execute({ operation_id: 'op-1' }, 'company-1', 'user-1', supabase as never)
    ).rejects.toThrow(/already committed/i)
  })

  it('throws when the op is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'not found' } })

    await expect(
      rejectTool.execute({ operation_id: 'missing' }, 'company-1', 'user-1', supabase as never)
    ).rejects.toThrow(/not found/i)
  })
})

// Founder decision 2026-10-03 (follow-up to issue #3408): a key with a write
// scope may reject (withdraw) pending operations without
// pending_operations:approve, but only the ones it staged itself.
describe('gnubok_reject_pending_operation: who may reject', () => {
  const KEY = 'a1a1a1a1-0000-4000-8000-000000000001'
  const OTHER_KEY = 'b2b2b2b2-0000-4000-8000-000000000002'
  const WRITE_KEY = ['pending_operations:read', 'transactions:write']
  const APPROVE_KEY = ['pending_operations:read', 'pending_operations:approve']
  const actor = { type: 'api_key' as const, id: KEY, label: 'Claude' }

  async function attempt(
    keyScopes: string[] | undefined,
    op: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: { code?: string; message: string }; supabase: ReturnType<typeof createQueuedMockSupabase> }> {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { id: 'op-1', status: 'pending', operation_type: 'categorize_transaction', risk_level: 'low', ...op }, error: null })
    mock.enqueue({ data: [{ id: 'op-1' }], error: null }) // CAS update
    const args: Record<string, unknown> = { operation_id: 'op-1', ...(keyScopes ? { __keyScopes: keyScopes } : {}) }
    try {
      const result = await rejectTool.execute(args, 'company-1', 'user-1', mock.supabase as never, actor)
      return { result, supabase: mock }
    } catch (err) {
      return { error: err as { code?: string; message: string }, supabase: mock }
    }
  }

  it('a write key without approve rejects a proposal it staged itself', async () => {
    const { result, error, supabase } = await attempt(WRITE_KEY, { actor_type: 'api_key', actor_id: KEY })
    expect(error).toBeUndefined()
    expect(result).toEqual({ status: 'rejected', operation_id: 'op-1' })
    const update = supabase.findCall('pending_operations', 'update')?.[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: 'rejected', result_data: { rejected_via: 'api_key', actor_id: KEY } })
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it("refuses another connection's proposal and names who staged it", async () => {
    const { error, supabase } = await attempt(WRITE_KEY, { actor_type: 'api_key', actor_id: OTHER_KEY, actor_label: 'Cursor' })
    expect(error?.code).toBe('INSUFFICIENT_SCOPE')
    expect(error?.message).toContain('only the agent proposals it staged itself')
    expect(error?.message).toContain('another connection (Cursor)')
    // Refused before any write.
    expect(supabase.findCall('pending_operations', 'update')).toBeUndefined()
  })

  it("refuses a person's proposal made in the app", async () => {
    const { error, supabase } = await attempt(WRITE_KEY, { actor_type: 'user', actor_id: null })
    expect(error?.code).toBe('INSUFFICIENT_SCOPE')
    expect(error?.message).toContain('a person in Accounted')
    expect(supabase.findCall('pending_operations', 'update')).toBeUndefined()
  })

  it('refuses a key with no write scope, even for a row carrying its id', async () => {
    const { error, supabase } = await attempt(['pending_operations:read'], { actor_type: 'api_key', actor_id: KEY })
    expect(error?.code).toBe('INSUFFICIENT_SCOPE')
    expect(error?.message).toContain('nor a write scope')
    expect(supabase.findCall('pending_operations', 'update')).toBeUndefined()
  })

  it('a key with approve still rejects anyone\'s proposal', async () => {
    for (const op of [
      { actor_type: 'api_key', actor_id: OTHER_KEY },
      { actor_type: 'user', actor_id: null },
    ]) {
      const { result, error } = await attempt(APPROVE_KEY, op)
      expect(error).toBeUndefined()
      expect(result).toEqual({ status: 'rejected', operation_id: 'op-1' })
    }
  })

  it('an API-key caller whose scopes were not injected is refused, not trusted', async () => {
    const { error, supabase } = await attempt(undefined, { actor_type: 'api_key', actor_id: KEY })
    expect(error?.code).toBe('INSUFFICIENT_SCOPE')
    expect(supabase.findCall('pending_operations', 'update')).toBeUndefined()
  })

  it('checks authority before status: a resolved proposal of someone else is refused on authority, not as a conflict', async () => {
    const { error } = await attempt(WRITE_KEY, { actor_type: 'user', actor_id: null, status: 'committed' })
    expect(error?.code).toBe('INSUFFICIENT_SCOPE')
  })
})
