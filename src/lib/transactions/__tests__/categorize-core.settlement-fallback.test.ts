/**
 * categorizeMatchedTransaction: settlement-account currency fallback (#1722).
 *
 * A transaction with NO cash_account_id (legacy/unresolved rows) used to book
 * its bank leg on the hardcoded 1930 from the category/template mapping even
 * when the company's only bank account is e.g. 1920 (PlusGiro), while the
 * booking dialogs previewed 1920 via the client-side resolveAccount. The
 * server resolver now mirrors that fallback: exactly one enabled cash account
 * in the transaction's currency wins; anything ambiguous keeps 1930.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockCreateJE = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJE(...args),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))

import { categorizeMatchedTransaction } from '../categorize-core'

const TX_ID = '00000000-0000-4000-8000-0000000000dd'

const txRow = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  company_id: 'company-1',
  date: '2026-07-10',
  amount: -479,
  currency: 'SEK',
  amount_sek: -479,
  exchange_rate: 1,
  description: 'KONTORSMATERIAL',
  merchant_name: null,
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  ...over,
})

const settingsRow = { entity_type: 'aktiebolag', fiscal_year_start_month: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockCreateJE.mockResolvedValue({ id: 'je-settle-1' })
})

describe('categorizeMatchedTransaction: single-account currency fallback (#1722)', () => {
  it('books the bank leg on the single enabled cash account, not the hardcoded 1930', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: txRow() }) // transactions select
    enqueue({ data: settingsRow }) // company_settings
    // The company's ONLY enabled SEK cash account books on 1920.
    enqueue({ data: [{ ledger_account: '1920' }] }) // resolveSettlementAccount currency fallback
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
    enqueue({ data: [{ id: TX_ID }] }) // transactions update (CAS)

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'expense_office' },
    )

    expect(result.error).toBeUndefined()
    expect(result.data?.journal_entry_id).toBe('je-settle-1')
    // 5th arg of createTransactionJournalEntry is the mapping result: its
    // 1930 leg was rewritten to the company's real settlement account.
    const mappingArg = mockCreateJE.mock.calls[0][4] as { credit_account: string }
    expect(mappingArg.credit_account).toBe('1920')
    // The fallback listing was narrowed to enabled accounts in the
    // transaction's currency.
    const eqArgs = findCalls('cash_accounts', 'eq')
    expect(eqArgs).toContainEqual(['enabled', true])
    expect(eqArgs).toContainEqual(['currency', 'SEK'])
  })

  it('keeps 1930 when the company has several enabled accounts in the currency', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: settingsRow })
    // Two enabled SEK accounts: ambiguous, so no guessing.
    enqueue({ data: [{ ledger_account: '1920' }, { ledger_account: '1930' }] })
    enqueue({ data: [{ id: 'fp-1' }] })
    enqueue({ data: [{ id: TX_ID }] })

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'expense_office' },
    )

    expect(result.error).toBeUndefined()
    const mappingArg = mockCreateJE.mock.calls[0][4] as { credit_account: string }
    expect(mappingArg.credit_account).toBe('1930')
  })
})
