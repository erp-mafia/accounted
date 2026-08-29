/**
 * commitReconciliationResidual, driven through the public commitPendingOperation
 * dispatcher. The booking itself lives in lib/reconciliation/residual.ts (unit
 * tested there); these tests cover the wiring: param validation, the
 * refusal-to-status mapping, and the committed payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

const residualMock = vi.fn()
vi.mock('@/lib/reconciliation/residual', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/residual')>('@/lib/reconciliation/residual')
  return { ...actual, bookResidualAndLink: (...args: unknown[]) => residualMock(...args) }
})

import { ReconciliationResidualError } from '@/lib/reconciliation/residual'
import { commitPendingOperation } from '../commit'

const CASH = '11111111-1111-4111-8111-111111111111'
const KEY = `bank:${CASH}`
const T1 = '22222222-2222-4222-8222-222222222222'
const E1 = '44444444-4444-4444-8444-444444444444'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'reconciliation_residual',
    status: 'pending',
    title: 'test',
    params: { account_key: KEY, external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' },
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-08-25T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-08-25T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: reconciliation_residual', () => {
  it('fails 400 when the staged params are incomplete, without booking', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({ params: { account_key: KEY, external_ids: [], journal_entry_id: E1, kind: 'bank_fee' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(residualMock).not.toHaveBeenCalled()
  })

  it('books and links through the shared service and returns the residual verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's committed update
    residualMock.mockResolvedValue({
      dry_run: false,
      residual_journal_entry_id: 'res-1',
      residual_amount: -10,
      applied: [{ external_id: T1, journal_entry_id: E1 }],
      skipped: [],
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))
    expect(residualMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      KEY,
      { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee', entry_date: undefined, description: undefined },
      { dryRun: false },
    )
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ account_key: KEY, residual_journal_entry_id: 'res-1', residual_amount: -10 })
  })

  it('maps a policy refusal to 400 with the residual code, and missing rows to a 404 auto-reject', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })
    residualMock.mockRejectedValueOnce(new ReconciliationResidualError('över taket', 'RESIDUAL_TOO_LARGE'))
    const refused = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))
    expect(refused.status).toBe('failed')
    expect(refused.http_status).toBe(400)
    expect(refused.code).toBe('RESIDUAL_TOO_LARGE')

    const second = createQueuedMockSupabase()
    second.enqueue({ data: { id: 'op-1' }, error: null })
    second.enqueue({ data: null, error: null })
    residualMock.mockRejectedValueOnce(new ReconciliationResidualError('saknas', 'RESIDUAL_ROWS_NOT_FOUND'))
    const missing = await commitPendingOperation(second.supabase as never, 'user-1', 'company-1', makePendingOp({}))
    expect(missing.status).toBe('rejected')
    expect(missing.http_status).toBe(404)
  })

  it('404s an account key the company does not own', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })
    residualMock.mockResolvedValueOnce(null)
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
  })
})
