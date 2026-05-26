import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

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

describe('pending_operations MCP tools — registration', () => {
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
    expect(commitSpy.mock.calls[0][4]).toMatchObject({ commitMethod: 'user_accept' })
    expect(result.status).toBe('committed')
    expect(result.operation_id).toBe('op-1')
    expect(result.data?.invoice_id).toBe('inv-1')
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
    enqueue({ data: [{ id: 'op-1' }], error: null }) // update CAS — returns rows

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
    enqueue({ data: [], error: null }) // update CAS — 0 rows (lost race)

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
