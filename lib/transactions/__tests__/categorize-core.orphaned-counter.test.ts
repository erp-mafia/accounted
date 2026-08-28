/**
 * Issue #1643 problem 4: the categorize commit path must never book the
 * COUNTER leg onto an orphaned cash-account ledger (a 19xx account held by a
 * revoked bank connection, or a stale IBAN twin of a live account). Confirming
 * such a proposal silently drops revenue/expense from the P&L onto a junk
 * balance-sheet account.
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
  amount: 217.04,
  currency: 'SEK',
  amount_sek: 217.04,
  exchange_rate: 1,
  description: 'Insättningsränta',
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
  mockCreateJE.mockResolvedValue({ id: 'je-1' })
})

describe('categorizeMatchedTransaction: orphaned counter-account guard', () => {
  it('refuses to book when the override counter is a ledger held by a revoked connection', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() }) // transactions select
    enqueue({ data: settingsRow }) // company_settings
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    // Override chart hit: 1931 exists and is active in the chart (the orphaned
    // ledger was auto-created there by the broken reconnect).
    enqueue({ data: { account_number: '1931', account_class: 1, is_active: true } })
    // Guard: cash_accounts scan finds 1931 held by a revoked connection.
    enqueue({
      data: [
        { id: 'ca-orphan', ledger_account: '1931', bank_connection_id: 'conn-old', iban: 'SE455', enabled: true },
      ],
    })
    enqueue({ data: [{ id: 'conn-old', status: 'revoked' }] })

    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'income_services', vatTreatment: 'exempt', accountOverride: '1931' },
    )

    expect(result.status).toBe(400)
    expect(result.error).toMatch(/1931/)
    expect(result.error).toMatch(/frånkopplad/)
    expect(mockCreateJE).not.toHaveBeenCalled()
  })

  it('still books when the 19xx counter is a live cash account (genuine transfer target)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow({ amount: -500, amount_sek: -500 }) })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount fallback -> 1930
    enqueue({ data: { account_number: '1940', account_class: 1, is_active: true } }) // override chart hit
    // Guard: 1940 is held by an ACTIVE connection -> not orphaned.
    enqueue({
      data: [
        { id: 'ca-live', ledger_account: '1940', bank_connection_id: 'conn-live', iban: 'SE455', enabled: true },
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
    enqueue({ data: [txRow({ journal_entry_id: 'je-1' })] }) // transactions update

    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'expense_other', vatTreatment: 'exempt', accountOverride: '1940' },
    )

    expect(result.error).toBeUndefined()
    expect(mockCreateJE).toHaveBeenCalled()
  })
})
