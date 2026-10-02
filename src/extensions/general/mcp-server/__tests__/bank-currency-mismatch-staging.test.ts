/**
 * Feedback seq 753539: the bank row was SEK, its cash account 'XXX'. The
 * bank-booking guards look the account up by the row's currency, so approval
 * failed (match_batch_allocate: BANK_BOOKING_CASH_ACCOUNT_MISSING; the link:
 * BANK_ANCHOR_CASH_ACCOUNT_CHANGED, "reload and try again") after staging had
 * shown a plausible preview. Both tools now refuse at staging, before any
 * pending operation exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockDetectSet } = vi.hoisted(() => ({ mockDetectSet: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: mockDetectSet,
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/batch-cash-method-guard', () => ({
  findCashMethodUnbookedAllocations: vi.fn(async () => ({ ok: true, unbooked: [] })),
}))

import { tools } from '../server'

const allocate = tools.find((t) => t.name === 'gnubok_match_batch_allocate')!
const link = tools.find((t) => t.name === 'gnubok_link_transaction_to_journal_entry')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'
const JE_ID = '33333333-3333-4333-8333-333333333333'
const actor = { type: 'api_key' } as never

const bankRow = { id: TX_ID, description: 'BGGIRERING', merchant_name: null, amount: 350000, currency: 'SEK',
  amount_sek: null, exchange_rate: null, cash_account_id: 'ca-1', date: '2026-08-31', journal_entry_id: null }

beforeEach(() => {
  vi.clearAllMocks()
  mockDetectSet.mockResolvedValue(null)
})

describe('bank row and cash account in different currencies', () => {
  it('match_batch_allocate refuses at staging instead of failing at approval', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: bankRow, error: null })
    enqueue({ data: [{ id: INV_ID, document_type: 'invoice', currency: 'SEK', exchange_rate: null, remaining_amount: 350000, total: 350000 }], error: null })
    enqueue({ data: { ledger_account: '1930', currency: 'XXX' }, error: null }) // cash_accounts

    await expect(allocate.execute(
      { transaction_id: TX_ID, allocations: [{ kind: 'customer_invoice', invoice_id: INV_ID, amount: 350000 }] },
      'company-1', 'user-1', supabase as never, actor,
    )).rejects.toMatchObject({ code: 'BANK_BOOKING_CURRENCY_MISMATCH' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('link_transaction_to_journal_entry refuses at staging instead of failing at approval', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: bankRow, error: null })
    enqueue({ data: { ledger_account: '1930', currency: 'XXX' }, error: null }) // cash_accounts

    await expect(link.execute(
      { transaction_id: TX_ID, journal_entry_id: JE_ID },
      'company-1', 'user-1', supabase as never, actor,
    )).rejects.toMatchObject({ code: 'BANK_BOOKING_CURRENCY_MISMATCH' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('link_transaction_to_journal_entry still stages a row whose account shares its currency', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: bankRow, error: null })
    enqueue({ data: { ledger_account: '1930', currency: 'SEK' }, error: null }) // cash_accounts
    enqueue({ data: { id: JE_ID, status: 'posted', voucher_series: 'A', voucher_number: 12, entry_date: '2026-08-31' }, error: null })
    enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company_settings
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null }) // fiscal_periods
    enqueue({ data: { id: 'op-link-1' }, error: null }) // pending_operations insert

    const result = (await link.execute(
      { transaction_id: TX_ID, journal_entry_id: JE_ID },
      'company-1', 'user-1', supabase as never, actor,
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    expect(findCalls('cash_accounts', 'eq')).toContainEqual(['id', 'ca-1'])
  })
})
