/**
 * Approving a staged update_company_settings that turns dimensions on
 * registers the dimension codes already on journal lines, as the settings
 * page and v1 do: the registration is part of the settings service, not of
 * a door. Before, only the settings page's toggle ran it, so an agent turning
 * dimensions on left the registry without the history's codes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { commitPendingOperation } from '../commit'

function makePendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'update_company_settings',
    status: 'pending',
    title: 'Uppdatera företagsinställningar',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-09-28T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-09-28T00:00:00Z',
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: update_company_settings turning dimensions on', () => {
  it('registers the codes already on journal lines as archived values', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { company_id: 'company-1', dimensions_enabled: false }, error: null }) // stored settings
    enqueue({ data: { role: 'owner' }, error: null }) // the approver's role (settings are owner/admin only)
    enqueue({ data: { company_id: 'company-1', dimensions_enabled: true }, error: null }) // update ... returning
    enqueue({ data: null, error: null, count: 5 }) // system tax deadlines exist: no regeneration
    enqueue({ data: null, error: null }) // ensure_company_dimensions rpc
    enqueue({ data: [{ id: 'entry-1' }], error: null }) // the company's entries
    enqueue({ data: [{ id: 'line-1', journal_entry_id: 'entry-1', dimensions: { '6': 'P001' } }], error: null })
    enqueue({ data: [{ id: 'dim-6', sie_dim_no: 6 }], error: null }) // registry dimensions
    enqueue({ data: [], error: null }) // registered values
    enqueue({ data: [{ id: 'value-1' }], error: null }) // value upsert
    enqueue({ data: null, error: null }) // finalize update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ dimensions_enabled: true }),
    )

    expect(result.status).toBe('committed')
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('ensure_company_dimensions')
    expect(findCall('dimension_values', 'upsert')?.[0]).toEqual([
      { company_id: 'company-1', dimension_id: 'dim-6', code: 'P001', name: 'P001', is_active: false },
    ])
  })
})
