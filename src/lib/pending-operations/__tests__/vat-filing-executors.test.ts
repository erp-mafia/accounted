/**
 * commitPendingOperation for the momsdeklaration filing record (issues
 * #2785, #2786): an approved mark_vat_period_filed / unmark_vat_period_filed
 * runs the vat-filings operation (src/lib/operations/vat-filings.ts), which
 * calls the same store the dashboard and v1 routes use. The store is mocked
 * here (lib/vat/__tests__/filing-record-store.test.ts covers its rules); what
 * matters is that the approval reaches it with the staged period, and that a
 * refusal (a Skatteverket-confirmed filing) is reported with its code and a
 * non-empty error, never read as success.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

const store = vi.hoisted(() => ({
  listVatFilings: vi.fn(),
  markVatPeriodFiled: vi.fn(),
  unmarkVatPeriodFiled: vi.fn(),
  previewMarkVatPeriodFiled: vi.fn(),
  previewUnmarkVatPeriodFiled: vi.fn(),
  recordVatFilingConfirmed: vi.fn(),
}))
vi.mock('@/lib/vat/filing-record-store', () => store)

import { commitPendingOperation } from '../commit'

const YEARLY_RECORD = {
  deadline_id: '11111111-1111-4111-8111-111111111111',
  period_type: 'yearly',
  year: 2026,
  period: 1,
  tax_period: '2025/2026',
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  filed_on: '2026-08-20',
  source: 'manual',
  reference: 'KV-7',
}

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'mark_vat_period_filed',
    status: 'pending',
    title: 'Markera momsdeklaration Helår 2026 som inlämnad',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Agent',
    risk_level: 'low',
    created_at: '2026-09-27T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-09-27T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('mark_vat_period_filed', () => {
  it('records the staged helårsmoms filing through the store on approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // finalize update
    store.markVatPeriodFiled.mockResolvedValue({ ok: true, record: YEARLY_RECORD, created: false, changed: true })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: { period_type: 'yearly', year: 2026, period: 1, filed_on: '2026-08-20', reference: 'KV-7' },
      }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({ ...YEARLY_RECORD, created: false, changed: true })
    expect(store.markVatPeriodFiled).toHaveBeenCalledWith(supabase, 'company-1', {
      periodType: 'yearly',
      year: 2026,
      period: 1,
      filedOn: '2026-08-20',
      reference: 'KV-7',
      userId: 'user-1',
    })
    // The approval writes; it never re-runs the preview.
    expect(store.previewMarkVatPeriodFiled).not.toHaveBeenCalled()
  })

  it('reports a date refusal with its code and a message, never as success', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update
    store.markVatPeriodFiled.mockResolvedValue({ ok: false, code: 'VAT_FILING_PERIOD_NOT_ENDED' })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: { period_type: 'yearly', year: 2027, period: 1, filed_on: '2026-09-01' } }),
    )

    // A 400 lands as 'failed' (the op is consumed), a 409 as 'rejected'.
    expect(result.status).toBe('failed')
    expect(result.code).toBe('VAT_FILING_PERIOD_NOT_ENDED')
    expect(result.http_status).toBe(400)
    expect(result.error).toBeTruthy()
  })

  it('re-validates the staged params: a yearly period is always 1', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: { period_type: 'yearly', year: 2026, period: 6, filed_on: '2026-08-20' } }),
    )

    expect(result.status).toBe('failed')
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(store.markVatPeriodFiled).not.toHaveBeenCalled()
  })
})

describe('unmark_vat_period_filed', () => {
  it('puts a manual mark back to pending on approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // finalize update
    store.unmarkVatPeriodFiled.mockResolvedValue({ ok: true, deadline_id: YEARLY_RECORD.deadline_id })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        operation_type: 'unmark_vat_period_filed',
        params: { period_type: 'yearly', year: 2026, period: 1 },
      }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({ deadline_id: YEARLY_RECORD.deadline_id, unmarked: true })
    expect(store.unmarkVatPeriodFiled).toHaveBeenCalledWith(supabase, 'company-1', {
      periodType: 'yearly',
      year: 2026,
      period: 1,
    })
  })

  it('refuses a filing Skatteverket confirmed in the meantime, with its code', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update
    store.unmarkVatPeriodFiled.mockResolvedValue({ ok: false, code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET' })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        operation_type: 'unmark_vat_period_filed',
        params: { period_type: 'quarterly', year: 2026, period: 2 },
      }),
    )

    expect(result.status).toBe('rejected')
    expect(result.code).toBe('VAT_FILING_CONFIRMED_BY_SKATTEVERKET')
    expect(result.http_status).toBe(409)
    expect(result.error).toBeTruthy()
  })
})
