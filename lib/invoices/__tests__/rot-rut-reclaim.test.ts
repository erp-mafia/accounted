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

  it('refuses a request that already carries a reclaim voucher', async () => {
    enqueue({ data: makeRequestRow({ reclaim_journal_entry_id: 'je-old' }) })
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

  it('refuses an invoice without a verifikat: no 1513 debit exists to move', async () => {
    enqueue({ data: makeRequestRow() })
    enqueue({ data: [makeItem('i1', INVOICE_A, 5000, null, { journal_entry_id: null })] })
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({ ok: false, code: 'ROT_RUT_RECLAIM_INVOICE_NOT_BOOKED' })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
  })

  it('refuses a credited or cancelled invoice and a non-SEK invoice', async () => {
    enqueue({ data: makeRequestRow() })
    enqueue({ data: [makeItem('i1', INVOICE_A, 5000, null, { status: 'credited' })] })
    const credited = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(credited).toMatchObject({ ok: false, code: 'ROT_RUT_RECLAIM_INVOICE_NOT_OPEN' })

    reset()
    enqueue({ data: makeRequestRow() })
    enqueue({ data: [makeItem('i1', INVOICE_A, 5000, null, { currency: 'EUR' })] })
    const foreign = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(foreign).toMatchObject({ ok: false, code: 'ROT_RUT_RECLAIM_CURRENCY' })
    expect(mockCreateReclaimEntry).not.toHaveBeenCalled()
  })

  it('books one voucher and reopens every invoice for its refused share', async () => {
    // Two invoices, beslutsfil split: A fully approved (3 000), B refused (2 000).
    enqueue({ data: makeRequestRow() })
    enqueue({
      data: [
        makeItem('i1', INVOICE_A, 3000, 3000, { total: 6000, paid_amount: 3000, deduction_total: 3000 }),
        makeItem('i2', INVOICE_B, 2000, 0, { total: 4000, paid_amount: 2000, deduction_total: 2000 }),
      ],
    })
    enqueue({ data: { id: REQUEST_ID } }) // request CAS attach
    enqueue({ data: null }) // invoice B update
    enqueue({ data: null }) // item i2 update

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

    // Invoice reopened: reclaimed grows, remaining = total - paid - deduction + reclaimed.
    const invoiceUpdates = findCalls('invoices', 'update')
    expect(invoiceUpdates).toHaveLength(1)
    expect(invoiceUpdates[0][0]).toEqual({
      deduction_reclaimed_total: 2000,
      remaining_amount: 2000,
      status: 'partially_paid',
    })
    expect(findCall('rot_rut_payout_request_items', 'update')?.[0]).toEqual({ reclaimed_amount: 2000 })
  })

  it('reopens a full avslag on a never-paid customer share as sent', async () => {
    enqueue({ data: makeRequestRow({ status: 'rejected', decided_total: 0 }) })
    enqueue({
      data: [makeItem('i1', INVOICE_A, 5000, null, { status: 'sent', paid_amount: 0 })],
    })
    enqueue({ data: { id: REQUEST_ID } })
    enqueue({ data: null })
    enqueue({ data: null })

    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({
      ok: true,
      reclaimedTotal: 5000,
      invoices: [{ invoice_id: INVOICE_A, reclaimed_amount: 5000, remaining_amount: 10000, status: 'sent' }],
    })
  })

  it('reports a lost CAS as ROT_RUT_RECLAIM_RACE and never unbooks', async () => {
    enqueue({ data: makeRequestRow() })
    enqueue({ data: [makeItem('i1', INVOICE_A, 5000, null)] })
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
    enqueue({ data: makeRequestRow() })
    enqueue({ data: [makeItem('i1', INVOICE_A, 5000, null)] })
    mockCreateReclaimEntry.mockRejectedValue(new Error('Bokföringen är låst'))
    const outcome = await reclaimRotRutRefusal(supabase, 'user-1', 'company-1', params)
    expect(outcome).toMatchObject({ ok: false, kind: 'error', stage: 'book' })
    expect(findCalls('rot_rut_payout_requests', 'update')).toHaveLength(0)
  })
})
