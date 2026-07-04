/**
 * commitCreateDimensionValue: executor tests (dimensions PR3).
 *
 * The executor is private to lib/pending-operations/commit.ts and reached
 * through commitPendingOperation, same pattern as executors.test.ts. Staging-
 * side coverage (the MCP tool's pre-flight gates) lives in
 * extensions/general/mcp-server/__tests__/dimension-tools.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { commitPendingOperation } from '../commit'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_dimension_value',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'low',
    created_at: '2026-07-02T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-07-02T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: create_dimension_value', () => {
  it('happy path: seeds system dims, inserts the value, returns committed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // ensure_company_dimensions rpc (dim 6)
    enqueue({ data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false }, error: null })
    enqueue({ data: { id: 'val-1', code: 'P010', name: 'Etapp 2', is_active: true }, error: null }) // insert
    enqueue({ data: null, error: null }) // finalize update

    const op = makePendingOp({
      params: { sie_dim_no: 6, code: 'P010', name: 'Etapp 2' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      dimension_value_id: 'val-1',
      sie_dim_no: 6,
      dimension_name: 'Projekt',
      code: 'P010',
      name: 'Etapp 2',
      already_existed: false,
    })
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('ensure_company_dimensions')
  })

  it('duplicate code (23505) is idempotent: re-reads the existing row and reports success', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({ data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false }, error: null })
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key value' } }) // insert conflict
    enqueue({ data: { id: 'val-existing', code: 'P010', name: 'Etapp 2', is_active: true }, error: null }) // re-read
    enqueue({ data: null, error: null }) // finalize update

    const op = makePendingOp({
      params: { sie_dim_no: 6, code: 'P010', name: 'Etapp 2' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      dimension_value_id: 'val-existing',
      already_existed: true,
    })
  })

  it('rejects an unknown custom dimension (no ensure RPC for non-system dims)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dimensions lookup → not found
    enqueue({ data: null, error: null }) // dispatcher reject update

    const op = makePendingOp({
      params: { sie_dim_no: 12, code: 'X1', name: 'Custom' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Okänd dimension 12/)
    // ensure_company_dimensions must NOT run for non-system dims: agents may
    // stage new VALUES, never new dimensions.
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('re-validates staged params at the commit boundary (tampered code rejected)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const op = makePendingOp({
      params: { sie_dim_no: 6, code: 'has "quotes" and spaces', name: 'Tampered' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Invalid code/)
  })

  it('rejects value dates on a resets-annually dimension', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // ensure rpc (dim 1)
    enqueue({ data: { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true }, error: null })
    enqueue({ data: null, error: null }) // dispatcher reject update

    const op = makePendingOp({
      params: { sie_dim_no: 1, code: 'KS01', name: 'Stockholm', start_date: '2026-01-01' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Start-\/slutdatum är inte tillåtna/)
  })
})
