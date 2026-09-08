import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'

const mockSettle = vi.fn()
const mockSettleSet = vi.fn()
vi.mock('@/lib/invoices/rot-rut-settle', () => ({
  settleRotRutPayoutRequest: (...args: unknown[]) => mockSettle(...args),
  settleRotRutPayoutRequestSet: (...args: unknown[]) => mockSettleSet(...args),
}))

const mockResolveSettlementAccount = vi.fn()
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: (...args: unknown[]) => mockResolveSettlementAccount(...args),
}))

const mockHasLiveLink = vi.fn()
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: (...args: unknown[]) => mockHasLiveLink(...args),
}))

import { matchTransactionToRotRutPayout } from '../rot-rut-match-transaction'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient
const log = createLogger('test')

const TX_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_A = '22222222-2222-4222-8222-222222222222'
const REQUEST_B = '44444444-4444-4444-8444-444444444444'

function makeTxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    date: '2026-07-10',
    amount: 3000,
    currency: 'SEK',
    journal_entry_id: null,
    cash_account_id: 'ca-1',
    transaction_voucher_links: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockResolveSettlementAccount.mockResolvedValue('1930')
  mockHasLiveLink.mockResolvedValue(false)
  mockSettle.mockResolvedValue({
    ok: true,
    journalEntryId: 'je-1',
    amount: 3000,
    fullyPaid: true,
    request: { id: REQUEST_A, name: 'ROT 2026-07', status: 'paid' },
  })
  mockSettleSet.mockResolvedValue({
    ok: true,
    journalEntryId: 'je-2',
    amount: 5000,
    requests: [
      { id: REQUEST_A, name: 'ROT 2026-07', status: 'paid' },
      { id: REQUEST_B, name: 'RUT 2026-07', status: 'paid' },
    ],
  })
})

describe('matchTransactionToRotRutPayout', () => {
  it('refuses an empty request list before touching the database', async () => {
    const outcome = await matchTransactionToRotRutPayout(
      supabase, 'user-1', 'company-1', { transactionId: TX_ID, requestIds: [] }, log,
    )
    expect(outcome).toEqual({ ok: false, kind: 'code', code: 'ROT_RUT_REQUEST_NOT_FOUND' })
  })

  it('reports an unknown transaction', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const outcome = await matchTransactionToRotRutPayout(
      supabase, 'user-1', 'company-1', { transactionId: TX_ID, requestIds: [REQUEST_A] }, log,
    )
    expect(outcome).toMatchObject({ ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' })
  })

  it('refuses an expense row and a non-SEK row', async () => {
    enqueue({ data: makeTxRow({ amount: -3000 }) })
    const expense = await matchTransactionToRotRutPayout(
      supabase, 'user-1', 'company-1', { transactionId: TX_ID, requestIds: [REQUEST_A] }, log,
    )
    expect(expense).toMatchObject({ ok: false, code: 'ROT_RUT_MATCH_NOT_INCOME' })

    reset()
    enqueue({ data: makeTxRow({ currency: 'EUR' }) })
    const foreign = await matchTransactionToRotRutPayout(
      supabase, 'user-1', 'company-1', { transactionId: TX_ID, requestIds: [REQUEST_A] }, log,
    )
    expect(foreign).toMatchObject({ ok: false, code: 'ROT_RUT_MATCH_CURRENCY' })
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('refuses a row that is already booked (live pointer or bank_line junction)', async () => {
    enqueue({ data: makeTxRow({ journal_entry_id: 'je-old' }) })
    mockHasLiveLink.mockResolvedValue(true)
    const live = await matchTransactionToRotRutPayout(
      supabase, 'user-1', 'company-1', { transactionId: TX_ID, requestIds: [REQUEST_A] }, log,
    )
    expect(live).toMatchObject({ ok: false, code: 'ROT_RUT_MATCH_TX_ALREADY_LINKED' })

    reset()
    mockHasLiveLink.mockResolvedValue(false)
    enqueue({
      data: makeTxRow({ transaction_voucher_links: [{ journal_entry_id: 'je-bulk', role: 'bank_line' }] }),
    })
    const junction = await matchTransactionToRotRutPayout(
      supabase, 'user-1', 'company-1', { transactionId: TX_ID, requestIds: [REQUEST_A] }, log,
    )
    expect(junction).toMatchObject({ ok: false, code: 'ROT_RUT_MATCH_TX_ALREADY_LINKED' })
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('settles one begäran through the single writer with the row as amount, date and account', async () => {
    enqueue({ data: makeTxRow({ journal_entry_id: 'je-stale' }) })
    mockResolveSettlementAccount.mockResolvedValue('1920')
    const outcome = await matchTransactionToRotRutPayout(
      supabase, 'user-1', 'company-1', { transactionId: TX_ID, requestIds: [REQUEST_A] }, log,
    )
    expect(outcome).toMatchObject({
      ok: true,
      journalEntryId: 'je-1',
      amount: 3000,
      request: { id: REQUEST_A },
      requests: [{ id: REQUEST_A }],
    })
    expect(mockSettle).toHaveBeenCalledWith(supabase, 'user-1', 'company-1', {
      requestId: REQUEST_A,
      paymentDate: '2026-07-10',
      amount: 3000,
      bankAccount: '1920',
      transactionId: TX_ID,
      previousJournalEntryId: 'je-stale',
    })
    expect(mockSettleSet).not.toHaveBeenCalled()
  })

  it('settles a bundle through the set writer, de-duplicating ids', async () => {
    enqueue({ data: makeTxRow({ amount: 5000 }) })
    const outcome = await matchTransactionToRotRutPayout(
      supabase, 'user-1', 'company-1',
      { transactionId: TX_ID, requestIds: [REQUEST_A, REQUEST_B, REQUEST_A] },
      log,
    )
    expect(outcome).toMatchObject({ ok: true, journalEntryId: 'je-2', amount: 5000, fullyPaid: true })
    expect((outcome as { request?: unknown }).request).toBeUndefined()
    expect(mockSettleSet).toHaveBeenCalledWith(supabase, 'user-1', 'company-1', {
      requestIds: [REQUEST_A, REQUEST_B],
      paymentDate: '2026-07-10',
      amount: 5000,
      bankAccount: '1930',
      transactionId: TX_ID,
      previousJournalEntryId: null,
    })
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('passes a writer refusal through unchanged', async () => {
    enqueue({ data: makeTxRow() })
    mockSettle.mockResolvedValue({
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_AMOUNT_EXCEEDS',
      details: { amount: 3000, expected_amount: 2500 },
    })
    const outcome = await matchTransactionToRotRutPayout(
      supabase, 'user-1', 'company-1', { transactionId: TX_ID, requestIds: [REQUEST_A] }, log,
    )
    expect(outcome).toMatchObject({ ok: false, code: 'ROT_RUT_SETTLE_AMOUNT_EXCEEDS' })
  })
})
