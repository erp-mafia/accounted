/**
 * commitPendingOperation for an operation from the registry
 * (src/lib/operations): an approved pending operation of the operation's
 * pendingType runs the same run() the v1 and MCP doors run, with the staged
 * params re-validated at the commit boundary. create_dimension is the
 * example; nothing here is specific to dimensions beyond the fixtures.
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
    operation_type: 'create_dimension',
    status: 'pending',
    title: 'Ny dimension: Avdelning',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'low',
    created_at: '2026-09-25T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-09-25T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: an operation from the registry', () => {
  it('runs the operation for real and returns its data', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // ensure_company_dimensions rpc
    enqueue({ data: [{ sie_dim_no: 1 }, { sie_dim_no: 6 }], error: null }) // taken numbers
    enqueue({
      data: {
        id: 'dim-20',
        sie_dim_no: 20,
        name: 'Avdelning',
        parent_sie_dim_no: null,
        resets_annually: true,
        is_system: false,
        is_active: true,
        sort_order: 100,
      },
      error: null,
    }) // insert
    enqueue({ data: null, error: null }) // finalize update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: { name: 'Avdelning' } }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ dimension: { id: 'dim-20', sie_dim_no: 20 } })
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('ensure_company_dimensions')
  })

  it('answers the registry code when the operation refuses', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({ data: [{ sie_dim_no: 1 }, { sie_dim_no: 6 }, { sie_dim_no: 20 }], error: null }) // taken
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: { name: 'Avdelning', sie_dim_no: 20 } }),
    )

    // An executor's refusal lands as 'rejected', like every hand-written one.
    expect(result.status).toBe('rejected')
    expect(result.code).toBe('DIMENSION_NUMBER_TAKEN')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/Dimension 20 finns redan/)
  })

  it('re-validates staged params at the commit boundary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: { name: '' } }),
    )

    expect(result.status).toBe('failed')
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
