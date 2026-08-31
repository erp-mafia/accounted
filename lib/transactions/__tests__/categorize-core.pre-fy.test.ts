/**
 * Pre-FY booking (issue #1825): a bank transaction dated before the company's
 * first rakenskapsar (the aktiekapital deposit paid in before the Bolagsverket
 * registration date is the canonical case).
 *
 * Pins two behaviours:
 *   1. ensureFiscalPeriod never mints a calendar-year period for a pre-FY
 *      date: neither in the overlap case (constraint bounce) nor in the
 *      non-overlap case (silent pre-registration year).
 *   2. categorizeMatchedTransaction books the transaction (journal_entry_id
 *      set, no more "categorized without verifikat") via the clamp in
 *      createTransactionJournalEntry: entry lands in the first open period on
 *      its first day, with the real bank date in the verifikationstext.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { CreateJournalEntryInput } from '@/types'

// Real categorize-core + real transaction-entries; only the engine (DB commit
// path) and the side-channel helpers are stubbed.
const mockFindFiscalPeriod = vi.fn()
const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
  createJournalEntry: (
    _supabase: unknown,
    _companyId: string,
    _userId: string,
    input: CreateJournalEntryInput,
  ) => mockCreateJournalEntry(input),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))

import { categorizeMatchedTransaction, ensureFiscalPeriod } from '../categorize-core'

const TX_ID = '00000000-0000-4000-8000-0000000000fe'

const txRow = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  company_id: 'company-1',
  date: '2026-03-10',
  amount: 25000,
  currency: 'SEK',
  amount_sek: 25000,
  exchange_rate: 1,
  description: 'Insättning aktiekapital',
  merchant_name: null,
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockFindFiscalPeriod.mockResolvedValue(null)
  mockCreateJournalEntry.mockImplementation(async (input: CreateJournalEntryInput) => ({
    id: 'je-prefy-1',
    ...input,
  }))
})

describe('ensureFiscalPeriod: pre-FY guard', () => {
  it('performs no insert when the date predates the first period (overlap case)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] }) // no open period covers the date
    enqueue({ data: [{ period_start: '2026-05-12' }] }) // earliest period

    // 2026-03-10 with fiscalYearStartMonth=1: the calendar period 2026-01-01 to
    // 2026-12-31 would OVERLAP the real first period and bounce off the
    // exclusion constraint. The guard must return before any upsert.
    const ok = await ensureFiscalPeriod(supabase as never, 'user-1', 'company-1', '2026-03-10', 1)

    expect(ok).toBe(true)
    expect(findCalls('fiscal_periods', 'upsert')).toHaveLength(0)
  })

  it('performs no insert when the date predates the first period (non-overlap case)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ period_start: '2026-05-12' }] })

    // Deposit dated the calendar year BEFORE registration: the computed
    // 2025-01-01 to 2025-12-31 period would NOT overlap anything, and the old
    // code silently created a bogus pre-registration rakenskapsar.
    const ok = await ensureFiscalPeriod(supabase as never, 'user-1', 'company-1', '2025-12-15', 1)

    expect(ok).toBe(true)
    expect(findCalls('fiscal_periods', 'upsert')).toHaveLength(0)
  })

  it('still creates the next-year period for a date after the latest period', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ period_start: '2026-05-12' }] }) // earliest, before the date
    enqueue({ data: null }) // upsert

    const ok = await ensureFiscalPeriod(supabase as never, 'user-1', 'company-1', '2027-03-10', 1)

    expect(ok).toBe(true)
    expect(findCalls('fiscal_periods', 'upsert')).toHaveLength(1)
  })

  it('still creates a period when the company has none at all', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [] }) // no earliest period: brand-new company
    enqueue({ data: null }) // upsert

    const ok = await ensureFiscalPeriod(supabase as never, 'user-1', 'company-1', '2026-03-10', 1)

    expect(ok).toBe(true)
    expect(findCalls('fiscal_periods', 'upsert')).toHaveLength(1)
  })
})

describe('categorizeMatchedTransaction: pre-FY transaction gets a journal entry', () => {
  it('books via the clamp: journal_entry_id set, entry on the first day of the first period', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: txRow() }) // transactions select
    enqueue({ data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } }) // settings
    enqueue({ data: [] }) // ensureFiscalPeriod: no covering open period
    enqueue({ data: [{ period_start: '2026-05-12' }] }) // ensureFiscalPeriod: earliest
    // Issue #1661: a private marking runs checkPeriodLock before the engine.
    // A pre-FY date has no covering period, which is not a lock.
    enqueue({ data: { bookkeeping_locked_through: null } })
    enqueue({ data: null })
    // createTransactionJournalEntry clamp: earliest full row (open, unlocked)
    enqueue({
      data: [{ id: 'period-first', period_start: '2026-05-12', is_closed: false, locked_at: null }],
    })
    // guarded transactions update
    enqueue({
      data: [txRow({ is_business: false, category: 'private', journal_entry_id: 'je-prefy-1' })],
    })

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'private' },
    )

    expect(result.error).toBeUndefined()
    expect(result.data?.journal_entry_id).toBe('je-prefy-1')

    // The clamp booked into the first period on its first day, keeping the
    // real bank date in the verifikationstext.
    expect(mockCreateJournalEntry).toHaveBeenCalledOnce()
    const input = mockCreateJournalEntry.mock.calls[0][0] as CreateJournalEntryInput
    expect(input.fiscal_period_id).toBe('period-first')
    expect(input.entry_date).toBe('2026-05-12')
    expect(input.description).toContain('Affärshändelse 2026-03-10')

    // No bogus pre-registration rakenskapsar was minted along the way.
    expect(findCalls('fiscal_periods', 'upsert')).toHaveLength(0)

    // The transaction row carries the new verifikat (no more "Delvis bokförd").
    expect(findCalls('transactions', 'update')).toContainEqual([
      expect.objectContaining({ journal_entry_id: 'je-prefy-1' }),
    ])
  })
})
