/**
 * categorizeMatchedTransaction refuses a transaction that is anchored through
 * transaction_voucher_links (issue #1553).
 *
 * A row bulk-booked into a samlingsverifikat, or split over several verifikat
 * (linkTransactionToVouchers), carries journal_entry_id = NULL: the pointer
 * alone reads as "unbooked" and the categorize path would book it a second
 * time. The guard is role-aware: only 'bank_line' rows are slices of the
 * bank amount; a residual booking's 'other' row (lib/reconciliation/
 * residual.ts) left behind by a storno of the main verifikat must not strand
 * the row (its pointer is NULL and koppla-bort refuses it too).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockCreateJE = vi.fn()
const mockCheckPeriodLock = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJE(...args),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: vi.fn(),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn(),
}))
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: (...args: unknown[]) => mockCheckPeriodLock(...args),
}))

import { categorizeMatchedTransaction } from '../categorize-core'

const TX_ID = '00000000-0000-4000-8000-0000000000aa'

const txRow = (links: Array<{ journal_entry_id: string; role: string }>) => ({
  id: TX_ID,
  company_id: 'company-1',
  date: '2026-06-11',
  amount: -800,
  currency: 'SEK',
  amount_sek: -800,
  exchange_rate: 1,
  description: 'UTBETALNING',
  merchant_name: null,
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  transaction_voucher_links: links,
})

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockCreateJE.mockResolvedValue(null)
})

describe('categorizeMatchedTransaction: transaction_voucher_links guard (#1553)', () => {
  it('returns 409 and writes nothing for a row split over several verifikat (bank_line rows, NULL pointer)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: txRow([
        { journal_entry_id: 'je-utlagg-1', role: 'bank_line' },
        { journal_entry_id: 'je-utlagg-2', role: 'bank_line' },
      ]),
    })

    const result = await categorizeMatchedTransaction(supabase as never, 'user-1', 'company-1', TX_ID, {
      category: 'expense_other',
    })

    expect(result.status).toBe(409)
    expect(result.error).toMatch(/already has a journal entry/)
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(mockCreateJE).not.toHaveBeenCalled()
    // The read carried the junction rows along: no second query was needed.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('lets a row carrying only a residual "other" row past the guard', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow([{ journal_entry_id: 'je-residual', role: 'other' }]) })
    enqueue({ data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } }) // company_settings
    enqueue({ data: [] }) // resolveSettlementAccount
    enqueue({ data: [] }) // ensureFiscalPeriod: no open period
    enqueue({ data: [{ period_start: '2026-01-01' }] })
    enqueue({ data: null })
    mockCheckPeriodLock.mockResolvedValue({ locked: true, reason: 'period_is_closed', fiscal_period_id: 'fp-2026' })

    const result = await categorizeMatchedTransaction(supabase as never, 'user-1', 'company-1', TX_ID, {
      category: 'expense_other',
    })

    // Reached the engine (which fails closed on the locked period here):
    // the junction guard did not fire.
    expect(result.status).not.toBe(409)
    expect(mockCreateJE).toHaveBeenCalled()
  })
})
