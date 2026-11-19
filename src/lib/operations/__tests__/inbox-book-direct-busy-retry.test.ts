/**
 * The Inkorg's direct booking posts its verifikat, then claims the bank row for
 * it. The claim's guard refuses with CASH_ACCOUNT_OPERATION_BUSY while another
 * booking of the company is being numbered: given up on the first refusal, the
 * verifikat was stornoed, and when that storno hit the same lock it stood
 * posted beside a row that still read open and was booked again (#205). The
 * claim is retried first, as categorize retries it; the storno runs only once
 * the retries are spent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, parseJsonResponse, type TableMockResult } from '@/tests/helpers'
import { CASH_ACCOUNT_BUSY_RETRY } from '@/lib/bookkeeping/cash-account-busy'
import type { Logger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

const ENTRY_ID = '55555555-5555-4555-8555-555555555555'
const TX_ID = '11111111-1111-4111-8111-111111111111'

const { mockPost, mockReverse, mockClaimItem } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockReverse: vi.fn(),
  mockClaimItem: vi.fn(),
}))
vi.mock('@/lib/posting/port', () => ({ postingPort: { postJournalEntry: mockPost } }))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({ reverseOrphanedJournalEntry: mockReverse }))
vi.mock('@/lib/documents/inbox-item-claim', () => ({ claimInboxItemOrReverseEntry: mockClaimItem }))
vi.mock('@/lib/bookkeeping/voucher-warnings-guard', () => ({
  runVoucherWarningsGuard: vi.fn(async () => ({ ok: true, acknowledged: [] })),
  recordVoucherWarningsAcknowledged: vi.fn(async () => undefined),
}))
vi.mock('@/lib/bookkeeping/import-vat-base', () => ({ refuseImportVatWithoutBase: vi.fn(async () => null) }))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({ resolveSettlementAccount: vi.fn(async () => '1930') }))
vi.mock('@/lib/suggestion-log/inbox', () => ({
  snapshotInboxExtraction: vi.fn(async () => null),
  recordInboxDecision: vi.fn(async () => undefined),
}))
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async () => null),
  recordDecisions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/core/documents/document-service', () => ({ linkToJournalEntry: vi.fn(async () => undefined) }))
vi.mock('@/lib/transactions/inbox-underlag', () => ({ propagateUnderlagForBookedTransaction: vi.fn(async () => undefined) }))
vi.mock('../inbox-pair-guard', () => ({ refuseWhenPairBooked: vi.fn(async () => null) }))
vi.mock('../inbox-companion', () => ({ followPairedReceipt: vi.fn(async () => undefined) }))

import { bookInboxItemDirectly, type BookDirectContext } from '../inbox-book-direct'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
log.child = vi.fn(() => log) as unknown as Logger['child']

const busy = { code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY', details: null, hint: null }
const claimed: TableMockResult = { data: [{ id: TX_ID }], error: null }

/**
 * Book the item against its bank row; `claims` answers the bank row claim
 * attempts in order (the last one sticks).
 */
function book(claims: TableMockResult[]) {
  const answers = [...claims]
  const mock = createTableMockSupabase({
    invoice_inbox_items: { data: { id: 'item-1', document_id: null, matched_transaction_id: null, extracted_data: null }, error: null },
    transactions: (chain) => {
      if (chain.some((call) => call.method === 'update')) return answers.length > 1 ? answers.shift()! : answers[0]
      return {
        data: {
          id: TX_ID, journal_entry_id: null, reconciliation_method: null, is_ignored: false, cash_account_id: null,
          date: '2026-10-15', amount: -125, currency: 'SEK', amount_sek: null, exchange_rate: null, transaction_voucher_links: [],
        },
        error: null,
      }
    },
  })
  // When the storno is asked for, how many claim attempts had been made.
  mockReverse.mockImplementation(async () => {
    reverseAfterAttempts.push(mock.findCalls('transactions', 'update').length)
  })
  const ctx = { supabase: mock.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log } as BookDirectContext
  const outcome = bookInboxItemDirectly(ctx, 'item-1', {
    transaction_id: TX_ID,
    fiscal_period_id: '22222222-2222-4222-8222-222222222222',
    entry_date: '2026-10-15',
    description: 'Kontorsmaterial',
    lines: [
      { account_number: '6110', debit_amount: 125, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 125 },
    ],
  } as Parameters<typeof bookInboxItemDirectly>[2])
  return { outcome, claimAttempts: () => mock.findCalls('transactions', 'update').length }
}

let reverseAfterAttempts: number[] = []
const realDelays = CASH_ACCOUNT_BUSY_RETRY.delaysMs

beforeEach(() => {
  vi.clearAllMocks()
  reverseAfterAttempts = []
  CASH_ACCOUNT_BUSY_RETRY.delaysMs = [0, 0, 0, 0]
  mockPost.mockResolvedValue({ id: ENTRY_ID, lines: [] })
  mockClaimItem.mockResolvedValue({ status: 'claimed' })
})
afterEach(() => {
  CASH_ACCOUNT_BUSY_RETRY.delaysMs = realDelays
})

describe('bookInboxItemDirectly: the bank row claim under a busy bank-account lock', () => {
  it('claims the row on a retry and keeps the verifikat', async () => {
    const { outcome, claimAttempts } = book([{ data: null, error: busy }, { data: null, error: busy }, claimed])
    const result = await outcome

    expect(result).toMatchObject({ ok: true, transactionId: TX_ID })
    expect(claimAttempts()).toBe(3)
    expect(mockReverse).not.toHaveBeenCalled()
    expect(mockClaimItem).toHaveBeenCalledTimes(1)
  })

  it('stornos the verifikat only after every retry was refused, and answers the retryable 409', async () => {
    const { outcome, claimAttempts } = book([{ data: null, error: busy }])
    const result = await outcome
    if (result.ok) throw new Error('expected a refusal')
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(result.response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('CASH_ACCOUNT_OPERATION_BUSY')
    // One attempt and one per configured wait, then the storno.
    expect(claimAttempts()).toBe(CASH_ACCOUNT_BUSY_RETRY.delaysMs.length + 1)
    expect(mockReverse).toHaveBeenCalledTimes(1)
    expect(mockReverse).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', ENTRY_ID, expect.any(String), expect.any(Function))
    expect(reverseAfterAttempts).toEqual([CASH_ACCOUNT_BUSY_RETRY.delaysMs.length + 1])
    // The item is never claimed for a verifikat that is being reversed.
    expect(mockClaimItem).not.toHaveBeenCalled()
  })

  it('does not retry a lost race: another booking holds the row, so the verifikat is stornoed at once', async () => {
    const { outcome, claimAttempts } = book([{ data: [], error: null }])
    const result = await outcome
    if (result.ok) throw new Error('expected a refusal')
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(result.response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_RACE')
    expect(claimAttempts()).toBe(1)
    expect(reverseAfterAttempts).toEqual([1])
  })

  it('does not retry another database refusal', async () => {
    const { outcome, claimAttempts } = book([{ data: null, error: { code: '23514', message: 'some other refusal' } }])
    const result = await outcome

    expect(result.ok).toBe(false)
    expect(claimAttempts()).toBe(1)
    expect(reverseAfterAttempts).toEqual([1])
  })
})
