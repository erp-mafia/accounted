/**
 * categorizeMatchedTransaction fails closed on the engine's null return
 * (issue #1947).
 *
 * createTransactionJournalEntry returns null WITHOUT throwing when
 * findFiscalPeriod sees no OPEN period covering the date and the pre-FY clamp
 * does not apply: the covering rakenskapsar is closed (is_closed = true), or
 * no period exists there at all. The pre-fix core fell through to the
 * transactions update anyway, writing is_business/category with
 * journal_entry_id NULL: the row left "Att bokfora" and the nav badge while
 * still unbooked, and the pending operation / bulk driver reported success.
 *
 * These tests pin the guard: on a null entry NOTHING is written (no
 * transactions update, no counterparty template, no event) and the caller
 * gets a structured 400 whose errorCode distinguishes a closed period
 * (PERIOD_LOCKED) from a missing one (NO_OPEN_PERIOD_FOR_DATE), so
 * result_data.error_code carries it through the pending-operations layer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockCreateJE = vi.fn()
const mockReverseOrphanedJE = vi.fn()
const mockUpsertTemplate = vi.fn()
const mockCheckPeriodLock = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJE(...args),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: (...args: unknown[]) => mockReverseOrphanedJE(...args),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: (...args: unknown[]) => mockUpsertTemplate(...args),
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

/** A transaction dated inside a fiscal year that is klarmarkerad (closed). */
const txRow = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  company_id: 'company-1',
  date: '2024-11-15',
  amount: -1200,
  currency: 'SEK',
  amount_sek: -1200,
  exchange_rate: 1,
  description: 'PROGRAMVARA AB',
  merchant_name: null,
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  ...over,
})

const settingsRow = { entity_type: 'aktiebolag', fiscal_year_start_month: 1 }

/**
 * Queue the reads up to the engine call: transactions select,
 * company_settings, resolveSettlementAccount, ensureFiscalPeriod (no open
 * period, earliest period start not after the date, upsert bounces off the
 * closed year's range: return value is ignored by the caller).
 */
function enqueueUpToEngine(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: txRow() }) // transactions select
  enqueue({ data: settingsRow }) // company_settings
  enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
  enqueue({ data: [] }) // ensureFiscalPeriod: no OPEN period covers the date
  enqueue({ data: [{ period_start: '2024-01-01' }] }) // earliest period start (pre-FY guard passes)
  enqueue({ data: null }) // ensureFiscalPeriod upsert; its outcome is ignored by the caller
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockCreateJE.mockResolvedValue(null) // the engine's no-open-period null return
})

describe('categorizeMatchedTransaction: null engine return fails closed (issue #1947)', () => {
  it('refuses with PERIOD_LOCKED and writes nothing when the covering year is closed', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const categorizedHandler = vi.fn()
    eventBus.on('transaction.categorized', categorizedHandler)
    enqueueUpToEngine(enqueue)
    mockCheckPeriodLock.mockResolvedValue({
      locked: true,
      reason: 'period_is_closed',
      fiscal_period_id: 'fp-2024',
    })

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'expense_software' },
    )

    expect(result.status).toBe(400)
    expect(result.errorCode).toBe('PERIOD_LOCKED')
    expect(result.error).toBe('Bokföringen är låst för denna period.')
    expect(result.data).toBeUndefined()
    // The #1947 defect: the update ran anyway and stranded the row as
    // categorized-but-unbooked. Nothing may be written now.
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(mockUpsertTemplate).not.toHaveBeenCalled()
    expect(mockReverseOrphanedJE).not.toHaveBeenCalled()
    expect(categorizedHandler).not.toHaveBeenCalled()
    expect(mockCheckPeriodLock).toHaveBeenCalledWith(expect.anything(), 'company-1', '2024-11-15')
  })

  it('refuses with NO_OPEN_PERIOD_FOR_DATE and writes nothing when no period exists', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueUpToEngine(enqueue)
    mockCheckPeriodLock.mockResolvedValue({ locked: false, reason: 'no_fiscal_period' })

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'expense_software' },
    )

    expect(result.status).toBe(400)
    expect(result.errorCode).toBe('NO_OPEN_PERIOD_FOR_DATE')
    expect(result.error).toContain('räkenskapsperiod')
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(mockUpsertTemplate).not.toHaveBeenCalled()
  })
})

describe('categorizeMatchedTransaction: private marking in a locked period (issue #1661)', () => {
  it('refuses with TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED before the engine runs and writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueUpToEngine(enqueue)
    mockCheckPeriodLock.mockResolvedValue({
      locked: true,
      reason: 'period_locked_at_set',
      fiscal_period_id: 'fp-2024',
    })

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'private' },
    )

    expect(result.status).toBe(400)
    expect(result.errorCode).toBe('TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED')
    expect(result.error).toContain('Ignorera')
    expect(result.data).toBeUndefined()
    // A private marking is a real booking, so the lock applies; the pre-check
    // answers with the ignore-steering code instead of letting the engine run.
    expect(mockCreateJE).not.toHaveBeenCalled()
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(mockUpsertTemplate).not.toHaveBeenCalled()
  })

  it('keeps PERIOD_LOCKED for a business categorization in the same period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueUpToEngine(enqueue)
    mockCheckPeriodLock.mockResolvedValue({
      locked: true,
      reason: 'period_locked_at_set',
      fiscal_period_id: 'fp-2024',
    })

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'expense_software' },
    )

    expect(result.status).toBe(400)
    expect(result.errorCode).toBe('PERIOD_LOCKED')
  })
})
