import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockCreatePayoutEntry = vi.fn()
vi.mock('@/lib/bookkeeping/rot-rut-entries', () => ({
  createRotRutPayoutEntry: (...args: unknown[]) => mockCreatePayoutEntry(...args),
}))

const mockLogMatchEvent = vi.fn()
vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: (...args: unknown[]) => mockLogMatchEvent(...args),
}))

// Mocked so the sibling-hint sweep consumes no slot in the queued mock; its
// query shape is pinned by clear-settled-invoice-suggestions.test.ts.
const mockClearSuggestions = vi.fn()
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: (...args: unknown[]) => mockClearSuggestions(...args),
}))

const mockPropagateUnderlag = vi.fn()
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: (...args: unknown[]) => mockPropagateUnderlag(...args),
}))

import { settleRotRutPayoutRequest } from '../rot-rut-settle'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient

const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const TX_ID = '11111111-1111-4111-8111-111111111111'

function makeRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    company_id: 'company-1',
    name: 'ROT 2026-07',
    deduction_type: 'rot',
    status: 'submitted',
    requested_total: 3000,
    decided_total: null,
    decided_at: null,
    settlement_journal_entry_id: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockCreatePayoutEntry.mockResolvedValue({ id: 'je-1' })
})

describe('settleRotRutPayoutRequest', () => {
  it('returns ROT_RUT_REQUEST_NOT_FOUND for an unknown request', async () => {
    enqueue({ data: null })
    const outcome = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
    })
    expect(outcome).toEqual({ ok: false, kind: 'code', code: 'ROT_RUT_REQUEST_NOT_FOUND' })
    expect(mockCreatePayoutEntry).not.toHaveBeenCalled()
  })

  it('refuses an already settled or cancelled request before booking anything', async () => {
    enqueue({ data: makeRequestRow({ status: 'paid', settlement_journal_entry_id: 'je-0' }) })
    const settled = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
    })
    expect(settled.ok).toBe(false)
    expect(settled).toMatchObject({ code: 'ROT_RUT_SETTLE_INVALID_STATE' })

    enqueue({ data: makeRequestRow({ status: 'cancelled' }) })
    const cancelled = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
    })
    expect(cancelled).toMatchObject({ ok: false, code: 'ROT_RUT_SETTLE_INVALID_STATE' })
    expect(mockCreatePayoutEntry).not.toHaveBeenCalled()
  })

  it('refuses a partial payout when no beslut is recorded', async () => {
    enqueue({ data: makeRequestRow() })
    const outcome = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
      amount: 2500,
    })
    expect(outcome).toMatchObject({ ok: false, code: 'ROT_RUT_SETTLE_INVALID_STATE' })
    expect(mockCreatePayoutEntry).not.toHaveBeenCalled()
  })

  it('refuses a payout above the requested (or decided) amount before booking', async () => {
    enqueue({ data: makeRequestRow() })
    const over = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
      amount: 12500,
    })
    expect(over).toEqual({
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_AMOUNT_EXCEEDS',
      details: { amount: 12500, expected_amount: 3000, status: 'submitted' },
    })

    // With a beslut recorded, the beslut is the ceiling.
    reset()
    enqueue({ data: makeRequestRow({ decided_total: 2500 }) })
    const overDecided = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
      amount: 3000,
    })
    expect(overDecided).toMatchObject({ ok: false, code: 'ROT_RUT_SETTLE_AMOUNT_EXCEEDS' })
    expect(mockCreatePayoutEntry).not.toHaveBeenCalled()
  })

  it('reports ROT_RUT_SETTLE_RACE when another settle attached first, keeping the voucher', async () => {
    enqueue({ data: makeRequestRow() })
    enqueue({ data: null }) // request CAS on settlement_journal_entry_id IS NULL matched 0 rows

    const outcome = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
      transactionId: TX_ID,
    })

    expect(outcome).toEqual({
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_RACE',
      details: { journal_entry_id: 'je-1', request_id: REQUEST_ID },
    })
    expect(findCall('rot_rut_payout_requests', 'is')).toEqual(['settlement_journal_entry_id', null])
    // The loser never touches the bank row.
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('locks the link on a stale pointer when the route passes one (issue #988 rows)', async () => {
    enqueue({ data: makeRequestRow() })
    enqueue({
      data: makeRequestRow({ status: 'paid', settlement_journal_entry_id: 'je-1', decided_total: 3000 }),
    })
    enqueue({ data: [{ id: TX_ID }] })
    enqueue({ data: [] })

    const outcome = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
      amount: 3000,
      transactionId: TX_ID,
      previousJournalEntryId: 'je-reversed',
    })

    expect(outcome.ok).toBe(true)
    const eqCalls = findCalls('transactions', 'eq')
    expect(eqCalls).toContainEqual(['journal_entry_id', 'je-reversed'])
    expect(findCall('transactions', 'is')).toBeUndefined()
  })

  it('books the voucher, completes the request and mirrors decided_amount (headless)', async () => {
    enqueue({ data: makeRequestRow() })
    enqueue({
      data: makeRequestRow({ status: 'paid', settlement_journal_entry_id: 'je-1', decided_total: 3000 }),
    })
    enqueue({ data: [{ id: 'item-1', requested_amount: 3000 }] })
    enqueue({ data: null })

    const outcome = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
      bankAccount: '1920',
    })

    expect(outcome).toMatchObject({ ok: true, journalEntryId: 'je-1', amount: 3000, fullyPaid: true })
    expect(mockCreatePayoutEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        requestId: REQUEST_ID,
        amount: 3000,
        paymentDate: '2026-07-10',
        bankAccount: '1920',
      }),
    )
    const requestUpdate = findCall('rot_rut_payout_requests', 'update')?.[0] as Record<string, unknown>
    expect(requestUpdate).toMatchObject({
      settlement_journal_entry_id: 'je-1',
      status: 'paid',
      decided_total: 3000,
    })
    // No transaction was passed: nothing is written to transactions.
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(mockLogMatchEvent).not.toHaveBeenCalled()
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'rot_rut_payout_request',
      REQUEST_ID,
      { exceptTransactionId: null },
    )
  })

  it('links the bank transaction to the settlement voucher and clears its hints', async () => {
    enqueue({ data: makeRequestRow() })
    enqueue({
      data: makeRequestRow({ status: 'paid', settlement_journal_entry_id: 'je-1', decided_total: 3000 }),
    })
    enqueue({ data: [{ id: TX_ID }] }) // transactions CAS update
    enqueue({ data: [] }) // items
    // payment_match_log insert is mocked (logMatchEvent)

    const outcome = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
      amount: 3000,
      bankAccount: '1930',
      transactionId: TX_ID,
    })

    expect(outcome.ok).toBe(true)
    const txUpdate = findCall('transactions', 'update')?.[0] as Record<string, unknown>
    expect(txUpdate).toEqual({
      journal_entry_id: 'je-1',
      is_business: true,
      category: 'income_other',
      potential_invoice_id: null,
      potential_supplier_invoice_id: null,
      potential_rot_rut_payout_request_id: null,
      reconciliation_method: null,
    })
    // Optimistic lock: only a free row absorbs the link.
    expect(findCall('transactions', 'is')).toEqual(['journal_entry_id', null])
    expect(mockLogMatchEvent).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      TX_ID,
      'matched',
      expect.objectContaining({
        matchMethod: 'rot_rut_payout_manual_confirm',
        newState: expect.objectContaining({ journal_entry_id: 'je-1', rot_rut_payout_request_id: REQUEST_ID }),
      }),
    )
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'rot_rut_payout_request',
      REQUEST_ID,
      { exceptTransactionId: TX_ID },
    )
  })

  it('reports ROT_RUT_MATCH_TX_LINK_FAILED when the optimistic lock loses, keeping the voucher', async () => {
    enqueue({ data: makeRequestRow() })
    enqueue({
      data: makeRequestRow({ status: 'paid', settlement_journal_entry_id: 'je-1', decided_total: 3000 }),
    })
    enqueue({ data: [] }) // CAS matched 0 rows: someone booked the row meanwhile

    const outcome = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
      amount: 3000,
      transactionId: TX_ID,
    })

    expect(outcome).toEqual({
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_MATCH_TX_LINK_FAILED',
      details: { journal_entry_id: 'je-1', request_id: REQUEST_ID },
    })
    expect(mockLogMatchEvent).not.toHaveBeenCalled()
  })

  it('records a partial payout as partially_paid once a beslut exists', async () => {
    enqueue({ data: makeRequestRow({ decided_total: 2500, decided_at: '2026-07-01T00:00:00Z' }) })
    enqueue({
      data: makeRequestRow({
        status: 'partially_paid',
        settlement_journal_entry_id: 'je-2',
        decided_total: 2500,
      }),
    })
    mockCreatePayoutEntry.mockResolvedValue({ id: 'je-2' })

    const outcome = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
      amount: 2500,
    })

    expect(outcome).toMatchObject({ ok: true, journalEntryId: 'je-2', amount: 2500, fullyPaid: false })
    const requestUpdate = findCall('rot_rut_payout_requests', 'update')?.[0] as Record<string, unknown>
    expect(requestUpdate).toEqual({
      settlement_journal_entry_id: 'je-2',
      status: 'partially_paid',
      decided_total: 2500,
    })
    // No item mirror on a partial payout.
    expect(findCalls('rot_rut_payout_request_items', 'update')).toEqual([])
  })

  it('surfaces an engine failure as a raw error without touching the request', async () => {
    enqueue({ data: makeRequestRow() })
    mockCreatePayoutEntry.mockRejectedValue(new Error('No open fiscal period'))

    const outcome = await settleRotRutPayoutRequest(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
    })

    expect(outcome).toMatchObject({ ok: false, kind: 'error', stage: 'book' })
    expect(findCalls('rot_rut_payout_requests', 'update')).toEqual([])
  })
})
