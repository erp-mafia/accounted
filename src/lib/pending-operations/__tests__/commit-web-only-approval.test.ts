/**
 * Collections operations that hand an invoice over or escalate a case are
 * committed only by a person approving them in the web UI: every other
 * commit (an agent key, a bulk approval) is refused before the claim, so the
 * operation stays pending for that person.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'
import { commitPendingOperation } from '../commit'

function op(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'open_collection_case',
    status: 'pending',
    title: 'Skicka faktura till inkasso',
    params: { invoice_id: 'inv-1', expected_remaining: 1250 },
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-10-06T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-06T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: web-only approvals', () => {
  it('refuses a handover approved through an agent key, leaving it pending', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op({}), {
      commitMethod: 'api_key',
      actor: { type: 'api_key' },
    })
    expect(result).toMatchObject({ status: 'failed', http_status: 403, code: 'COLLECTION_ATTESTATION_WEB_ONLY', operation_status: 'pending' })
  })

  it('refuses an escalation in a bulk approval, and without any approver at all', async () => {
    const { supabase } = createQueuedMockSupabase()
    const escalation = op({ operation_type: 'collection_case_action', params: { invoice_id: 'inv-1', action: 'approve_step' } })
    expect(
      await commitPendingOperation(supabase as never, 'user-1', 'company-1', escalation, { commitMethod: 'bulk_accept', actor: { type: 'user' } }),
    ).toMatchObject({ code: 'COLLECTION_ATTESTATION_WEB_ONLY', operation_status: 'pending' })
    expect(await commitPendingOperation(supabase as never, 'user-1', 'company-1', escalation)).toMatchObject({
      code: 'COLLECTION_ATTESTATION_WEB_ONLY',
    })
  })

  it('lets an agent approve an action that only serves the case', async () => {
    const { supabase } = createQueuedMockSupabase()
    const pause = op({ operation_type: 'collection_case_action', params: { invoice_id: 'inv-1', action: 'pause' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', pause, {
      commitMethod: 'api_key',
      actor: { type: 'api_key' },
    }).catch((err: unknown) => ({ code: (err as Error).message }))
    expect(result.code).not.toBe('COLLECTION_ATTESTATION_WEB_ONLY')
  })

  it('refuses the daily collections batch through an agent key or a bulk approval, leaving it pending', async () => {
    const { supabase } = createQueuedMockSupabase()
    const batch = op({ operation_type: 'collections_daily_batch', params: { batch_date: '2026-10-07', items: [], excluded: [] }, actor_type: 'cron' })
    for (const opts of [
      { commitMethod: 'api_key' as const, actor: { type: 'api_key' as const } },
      { commitMethod: 'bulk_accept' as const, actor: { type: 'user' as const } },
    ]) {
      expect(await commitPendingOperation(supabase as never, 'user-1', 'company-1', batch, opts)).toMatchObject({
        status: 'failed',
        code: 'COLLECTION_ATTESTATION_WEB_ONLY',
        operation_status: 'pending',
      })
    }
  })

  it('refuses the daily collections batch from a person who is not an owner or administrator, before the claim', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: false, error: null })
    const batch = op({ operation_type: 'collections_daily_batch', params: { batch_date: '2026-10-07', items: [], excluded: [] }, actor_type: 'cron' })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', batch, {
      commitMethod: 'user_accept',
      actor: { type: 'user', label: 'ada@test.se' },
    })
    expect(result).toMatchObject({ status: 'failed', http_status: 403, code: 'COLLECTION_BATCH_ADMIN_ONLY', operation_status: 'pending' })
    expect(findCall('pending_operations', 'update')).toBeUndefined()
  })

  it('passes a person approving in the web UI on to the commit', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op({}), {
      commitMethod: 'user_accept',
      actor: { type: 'user', label: 'ada@test.se' },
    }).catch((err: unknown) => ({ code: (err as Error).message }))
    expect(result.code).not.toBe('COLLECTION_ATTESTATION_WEB_ONLY')
  })
})
