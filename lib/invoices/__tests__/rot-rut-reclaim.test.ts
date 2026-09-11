import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockCreateReclaimEntry = vi.fn()
vi.mock('@/lib/bookkeeping/rot-rut-entries', () => ({
  createRotRutReclaimEntry: (...args: unknown[]) => mockCreateReclaimEntry(...args),
}))

import { computeRefusedShares, reclaimRotRutRefusal } from '../rot-rut-reclaim'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient

const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const INVOICE_A = '11111111-1111-4111-8111-111111111111'
const INVOICE_B = '33333333-3333-4333-8333-333333333333'

function makeRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    name: 'RUT 2026-08',
    deduction_type: 'rut',
    status: 'partially_paid',
    requested_total: 5000,
    decided_total: 3000,
    decided_at: '2026-08-20T10:00:00Z',
    reclaim_journal_entry_id: null,
    ...overrides,
  }
}

function makeInvoiceRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    invoice_number: id === INVOICE_A ? '2026-001' : '2026-002',
    status: 'paid',
    currency: 'SEK',
    total: 10000,
    paid_amount: 5000,
    deduction_total: 5000,
    deduction_reclaimed_total: 0,
    journal_entry_id: 'je-issue',
    document_type: 'invoice',
    ...overrides,
  }
}

function makeItem(
  id: string,
  invoiceId: string,
  requested: number,
  decided: number | null,
  invoiceOverrides: Record<string, unknown> = {},
) {
  return {
    id,
    invoice_id: invoiceId,
    requested_amount: requested,
    decided_amount: decided,
    reclaimed_amount: null,
    invoice: makeInvoiceRow(invoiceId, invoiceOverrides),
  }
}

/** Queue order: request, items, sibling-request scan (empty), then the writes. */
function enqueueOpen(request: Record<string, unknown>, items: unknown[], siblings: unknown[] = []) {
  enqueue({ data: request })
  enqueue({ data: items })
  enqueue({ data: siblings })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockCreateReclaimEntry.mockResolvedValue({ id: 'je-reclaim' })
})

describe('computeRefusedShares', () => {
  it('needs a recorded beslut', () => {
    expect(
      computeRefusedShares({ requested_total: 5000, decided_total: null, decided_at: null }, [
        { id: 'i1', invoice_id: INVOICE_A, requested_amount: 5000, decided_amount: null },
      ]),
    ).toEqual({ ok: false, code: 'ROT_RUT_RECLAIM_NO_BESLUT' })
  })

  it('refuses every item on a full avslag, even without per-item amounts', () => {
    const result = computeRefusedShares(
      { requested_total: 5000, decided_total: 0, decided_at: '2026-08-20' },
      [
        { id: 'i1', invoice_id: INVOICE_A, requested_amount: 3000, decided_amount: null },
        { id: 'i2', invoice_id: INVOICE_B, requested_amount: 2000, decided_amount: null },
      ],
    )
    expect(result).toEqual({
      ok: true,
      total: 5000,
      shares: [
        { itemId: 'i1', invoiceId: INVOICE_A, refused: 3000 },
        { itemId: 'i2', invoiceId: INVOICE_B, refused: 2000 },
      ],
    })
  })

  it('uses the request total for a single-item begäran recorded without a per-item amount', () => {
    const result = computeRefusedShares(
      { requested_total: 5000, decided_total: 3000, decided_at: '2026-08-20' },
      [{ id: 'i1', invoice_id: INVOICE_A, requested_amount: 5000, decided_amount: null }],
    )
    expect(result).toMatchObject({ ok: true, total: 2000, shares: [{ refused: 2000 }] })
  })

  it('refuses to guess the split of a multi-item partial beslut without per-item amounts', () => {
    const result = computeRefusedShares(
      { requested_total: 5000, decided_total: 3000, decided_at: '2026-08-20' },
      [
        { id: 'i1', invoice_id: INVOICE_A, requested_amount: 3000, decided_amount: null },
        { id: 'i2', invoice_id: INVOICE_B, requested_amount: 2000, decided_amount: null },
      ],
    )
    expect(result).toEqual({ ok: false, code: 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN' })
  })

  it('takes per-item beslut amounts when the beslutsfil recorded them', () => {
    const result = computeRefusedShares(
      { requested_total: 5000, decided_total: 3000, decided_at: '2026-08-20' },
      [
        { id: 'i1', invoice_id: INVOICE_A, requested_amount: 3000, decided_amount: 3000 },
        { id: 'i2', invoice_id: INVOICE_B, requested_amount: 2000, decided_amount: 0 },
      ],
    )
    expect(result).toMatchObject({
      ok: true,
      total: 2000,
      shares: [
        { itemId: 'i1', refused: 0 },
        { itemId: 'i2', refused: 2000 },
      ],
    })
  })

  it('refuses per-item amounts that do not reconcile with the request-level beslut', () => {
    // Items say 4 000 refused, the header says 2 000: an inconsistent beslut
    // must not book legs for a different sum than it displays.
    const result = computeRefusedShares(
      { requested_total: 5000, decided_total: 3000, decided_at: '2026-08-20' },
      [
        { id: 'i1', invoice_id: INVOICE_A, requested_amount: 3000, decided_amount: 1000 },
        { id: 'i2', invoice_id: INVOICE_B, requested_amount: 2000, decided_amount: 0 },
      ],
    )
    expect(result).toEqual({ ok: false, code: 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN' })
  })

  it('reports nothing refused on a fully approved beslut', () => {
    const result = computeRefusedShares(
      { requested_total: 5000, decided_total: 5000, decided_at: '2026-08-20' },
      [{ id: 'i1', invoice_id: INVOICE_A, requested_amount: 5000, decided_amount: 5000 }],
    )
    expect(result).toMatchObject({ ok: true, total: 0 })
  })
})

describe('reclaimRotRutRefusal', () => {
  const params = { requestId: REQUEST_ID, bookingDate: '2026-08-21' }

  it('returns ROT_RUT_REQUEST_NOT_FOUND for an unknown request', async () => {
    enqueue({ data: null })
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toEqual({ ok: false, kind: 'code', code: 'ROT_RUT_REQUEST_NOT_FOUND' })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
  })

  it('refuses before booking when the beslut is not recorded', async () => {
    enqueue({ data: makeRequestRow({ status: 'submitted', decided_total: null, decided_at: null }) })
    enqueue({ data: [makeItem('i1', INVOICE_A, 5000, null)] })
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({ ok: false, code: 'ROT_RUT_RECLAIM_NO_BESLUT' })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
  })

  it('refuses a request whose reclaim voucher and every leg are already applied', async () => {
    enqueue({ data: makeRequestRow({ reclaim_journal_entry_id: 'je-old' }) })
    enqueue({ data: [{ ...makeItem('i1', INVOICE_A, 5000, null), reclaimed_amount: 2000 }] })
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({ ok: false, code: 'ROT_RUT_RECLAIM_ALREADY_DONE' })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
  })

  it('refuses a fully approved beslut: nothing to reclaim', async () => {
    enqueue({ data: makeRequestRow({ status: 'paid', decided_total: 5000 }) })
    enqueue({ data: [makeItem('i1', INVOICE_A, 5000, 5000)] })
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({ ok: false, code: 'ROT_RUT_RECLAIM_NOTHING_REFUSED' })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
  })

  it('refuses an unknown split instead of guessing it', async () => {
    enqueue({ data: makeRequestRow() })
    enqueue({ data: [makeItem('i1', INVOICE_A, 3000, null), makeItem('i2', INVOICE_B, 2000, null)] })
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({ ok: false, code: 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN' })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
  })

  it('refuses while an invoice is re-requested in a later live begäran', async () => {
    // Avslag on A, invoice re-requested in B (submitted): the refused share
    // stays at Skatteverket until B is decided.
    enqueueOpen(makeRequestRow({ status: 'rejected', decided_total: 0 }), [makeItem('i1', INVOICE_A, 5000, null)], [
      { invoice_id: INVOICE_A, request: { id: 'req-b', status: 'submitted', company_id: 'company-1' } },
    ])
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({
      ok: false,
      code: 'ROT_RUT_RECLAIM_INVOICE_REREQUESTED',
      details: { invoice_ids: [INVOICE_A] },
    })
    expect(findCall('rot_rut_payout_request_items', 'neq')).toEqual(['request_id', REQUEST_ID])
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
  })

  it('refuses an invoice without a verifikat: no 1513 debit exists to move', async () => {
    enqueueOpen(makeRequestRow(), [makeItem('i1', INVOICE_A, 5000, null, { journal_entry_id: null })])
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({ ok: false, code: 'ROT_RUT_RECLAIM_INVOICE_NOT_BOOKED' })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
  })

  it('refuses a credited or cancelled invoice and a non-SEK invoice', async () => {
    enqueueOpen(makeRequestRow(), [makeItem('i1', INVOICE_A, 5000, null, { status: 'credited' })])
    const credited = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(credited).toMatchObject({ ok: false, code: 'ROT_RUT_RECLAIM_INVOICE_NOT_OPEN' })

    reset()
    enqueueOpen(makeRequestRow(), [makeItem('i1', INVOICE_A, 5000, null, { currency: 'EUR' })])
    const foreign = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(foreign).toMatchObject({ ok: false, code: 'ROT_RUT_RECLAIM_CURRENCY' })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
  })

  it('books one voucher and reopens every invoice for its refused share', async () => {
    // Two invoices, beslutsfil split: A fully approved (3 000), B refused (2 000).
    enqueueOpen(makeRequestRow(), [
      makeItem('i1', INVOICE_A, 3000, 3000, { total: 6000, paid_amount: 3000, deduction_total: 3000 }),
      makeItem('i2', INVOICE_B, 2000, 0, { total: 4000, paid_amount: 2000, deduction_total: 2000 }),
    ])
    enqueue({ data: { id: REQUEST_ID } }) // request CAS attach
    enqueue({ data: { applied: true, remaining_amount: 2000, status: 'partially_paid' } }) // RPC for B

    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toEqual({
      ok: true,
      journalEntryId: 'je-reclaim',
      reclaimedTotal: 2000,
      invoices: [
        {
          invoice_id: INVOICE_B,
          invoice_number: '2026-002',
          reclaimed_amount: 2000,
          remaining_amount: 2000,
          status: 'partially_paid',
        },
      ],
    })

    // Only the refused invoice gets a leg.
    expect(mockCreateReclaimEntry).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      requestId: REQUEST_ID,
      requestName: 'RUT 2026-08',
      deductionType: 'rut',
      bookingDate: '2026-08-21',
      legs: [{ invoiceId: INVOICE_B, invoiceNumber: '2026-002', amount: 2000 }],
    })

    // Request CAS on reclaim_journal_entry_id IS NULL.
    const requestUpdate = findCall('rot_rut_payout_requests', 'update')?.[0] as Record<string, unknown>
    expect(requestUpdate).toMatchObject({ reclaim_journal_entry_id: 'je-reclaim' })
    expect(findCall('rot_rut_payout_requests', 'is')).toEqual(['reclaim_journal_entry_id', null])

    // Invoice reopened through the atomic RPC: the database validates the
    // amount and derives remaining/status; the caller names the share only.
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('apply_rot_rut_reclaim_invoice', {
      p_item_id: 'i2',
      p_invoice_id: INVOICE_B,
      p_company_id: 'company-1',
      p_reclaimed_amount: 2000,
    })
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })

  it('resumes a reclaim whose voucher exists but whose invoice legs were not applied', async () => {
    // Voucher + marker on the request landed, then the RPC failed for B.
    // The second call books nothing, skips the CAS, and applies B only.
    // Full avslag on both invoices: A's leg applied (marker 3 000), B's not.
    enqueueOpen(makeRequestRow({ reclaim_journal_entry_id: 'je-reclaim', status: 'rejected', decided_total: 0 }), [
      { ...makeItem('i1', INVOICE_A, 3000, null, { total: 6000, paid_amount: 3000, deduction_total: 3000 }), reclaimed_amount: 3000 },
      makeItem('i2', INVOICE_B, 2000, null, { total: 4000, paid_amount: 2000, deduction_total: 2000 }),
    ])
    enqueue({ data: { applied: true, remaining_amount: 2000, status: 'partially_paid' } }) // apply for B

    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({
      ok: true,
      journalEntryId: 'je-reclaim',
      reclaimedTotal: 2000,
      invoices: [{ invoice_id: INVOICE_B, reclaimed_amount: 2000, remaining_amount: 2000, status: 'partially_paid' }],
    })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
    expect(findCalls('rot_rut_payout_requests', 'update')).toHaveLength(0)
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('apply_rot_rut_reclaim_invoice', expect.objectContaining({ p_item_id: 'i2' }))
  })

  it('reports ROT_RUT_RECLAIM_ALREADY_DONE once every leg carries its marker', async () => {
    enqueueOpen(makeRequestRow({ reclaim_journal_entry_id: 'je-reclaim' }), [
      { ...makeItem('i1', INVOICE_A, 5000, null), reclaimed_amount: 2000 },
    ])
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({
      ok: false,
      code: 'ROT_RUT_RECLAIM_ALREADY_DONE',
      details: { journal_entry_id: 'je-reclaim' },
    })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('surfaces a failed invoice leg as an update-stage error and leaves the voucher standing', async () => {
    enqueueOpen(makeRequestRow(), [makeItem('i1', INVOICE_A, 5000, null)])
    enqueue({ data: { id: REQUEST_ID } })
    enqueue({ data: null, error: { message: 'deadlock detected' } })
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({ ok: false, kind: 'error', stage: 'update' })
    expect(mockCreateReclaimEntry).toHaveBeenCalledTimes(1)
  })

  it('reopens a full avslag on a never-paid customer share as sent', async () => {
    enqueueOpen(makeRequestRow({ status: 'rejected', decided_total: 0 }), [
      makeItem('i1', INVOICE_A, 5000, null, { status: 'sent', paid_amount: 0 }),
    ])
    enqueue({ data: { id: REQUEST_ID } })
    enqueue({ data: { applied: true, remaining_amount: 10000, status: 'sent' } })

    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({
      ok: true,
      reclaimedTotal: 5000,
      invoices: [{ invoice_id: INVOICE_A, reclaimed_amount: 5000, remaining_amount: 10000, status: 'sent' }],
    })
  })

  it('reports what the RPC derived for the reopened invoice, never its own arithmetic', async () => {
    // The database derives remaining/status (NULL paid_amount on a paid
    // invoice counts the customer share as paid there); the service relays it.
    enqueueOpen(makeRequestRow(), [
      makeItem('i1', INVOICE_A, 5000, null, { status: 'paid', paid_amount: null }),
    ])
    enqueue({ data: { id: REQUEST_ID } })
    enqueue({ data: { applied: true, remaining_amount: '2000.00', status: 'partially_paid' } })

    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({
      ok: true,
      reclaimedTotal: 2000,
      invoices: [{ invoice_id: INVOICE_A, reclaimed_amount: 2000, remaining_amount: 2000, status: 'partially_paid' }],
    })
  })

  it('reports a lost CAS as ROT_RUT_RECLAIM_RACE and never unbooks', async () => {
    enqueueOpen(makeRequestRow(), [makeItem('i1', INVOICE_A, 5000, null)])
    enqueue({ data: null }) // CAS lost: 0 rows
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({
      ok: false,
      code: 'ROT_RUT_RECLAIM_RACE',
      details: { journal_entry_id: 'je-reclaim', request_id: REQUEST_ID },
    })
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })

  it('surfaces an engine failure as a book-stage error without touching any row', async () => {
    enqueueOpen(makeRequestRow(), [makeItem('i1', INVOICE_A, 5000, null)])
    mockCreateReclaimEntry.mockRejectedValue(new Error('Bokföringen är låst'))
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({ ok: false, kind: 'error', stage: 'book' })
    expect(findCalls('rot_rut_payout_requests', 'update')).toHaveLength(0)
  })
})
