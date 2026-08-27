/**
 * categorizeMatchedTransaction: the accountOverride commit path.
 *
 * The MCP staging tool validates the override once, but the account can be
 * deactivated between staging and the user's approval, so the core re-applies
 * and re-validates independently. These tests pin that the posted mapping
 * carries the override account, and that a stale override degrades to a
 * structured 400 (never a posted entry on a dead account).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockCreateJE = vi.fn()
const mockReverseOrphanedJE = vi.fn()
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
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))

import { categorizeMatchedTransaction } from '../categorize-core'

const TX_ID = '00000000-0000-4000-8000-0000000000cc'

const txRow = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  company_id: 'company-1',
  date: '2026-07-10',
  amount: -479,
  currency: 'SEK',
  amount_sek: -479,
  exchange_rate: 1,
  description: 'SECOND HAND BUTIK',
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
  mockCreateJE.mockResolvedValue({ id: 'je-override-1' })
  mockReverseOrphanedJE.mockResolvedValue(undefined)
})

describe('categorizeMatchedTransaction: accountOverride', () => {
  it('atomically unignores the transaction when categorizing it', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const categorizedHandler = vi.fn()
    eventBus.on('transaction.categorized', categorizedHandler)
    enqueue({ data: txRow({ is_ignored: true }) })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'fp-1' }] })
    enqueue({
      data: [txRow({
        is_business: false,
        category: 'private',
        is_ignored: false,
        journal_entry_id: 'je-override-1',
      })],
    })

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'private' },
    )

    expect(result.error).toBeUndefined()
    expect(findCalls('transactions', 'update')).toContainEqual([
      expect.objectContaining({
        is_business: false,
        category: 'private',
        is_ignored: false,
        journal_entry_id: 'je-override-1',
      }),
    ])
    expect(categorizedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: expect.objectContaining({ is_ignored: false }),
      }),
    )
  })

  it('returns a race conflict and stornos the orphan when the guarded update matches no row', async () => {
    // Pre-#1947 this scenario reached the guarded update via a null engine
    // return; a null entry now fails closed BEFORE the update (see
    // categorize-core.fail-closed.test.ts), so the race is exercised with a
    // posted entry, whose orphan must be reversed.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'fp-1' }] })
    enqueue({ data: [] }) // guarded update: no row matched (concurrent categorization)

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'private' },
    )

    expect(result.status).toBe(409)
    expect(mockReverseOrphanedJE).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-override-1',
      expect.any(String),
    )
  })

  it('posts the entry with the override on the business side', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() }) // transactions select
    enqueue({ data: settingsRow }) // company_settings
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: { account_number: '4020', account_class: 4, is_active: true } }) // override chart hit
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod: open period exists
    enqueue({ data: [{ id: TX_ID }] }) // transactions update

    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'expense_other', vatTreatment: 'exempt', accountOverride: '4020' },
    )

    expect(result.error).toBeUndefined()
    expect(result.data?.journal_entry_id).toBe('je-override-1')
    // 5th arg of createTransactionJournalEntry is the mapping result.
    const mappingArg = mockCreateJE.mock.calls[0][4] as {
      debit_account: string
      credit_account: string
    }
    expect(mappingArg.debit_account).toBe('4020')
    expect(mappingArg.credit_account).toBe('1930')
  })

  it('books GROSS with no auto-VAT line when the override has no explicit VAT intent', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: { account_number: '4020', account_class: 4, is_active: true } })
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
    enqueue({ data: [{ id: TX_ID }] }) // transactions update

    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      // No vatTreatment and no vatAmount: the category default standard_25
      // must NOT ride along onto the custom account.
      { category: 'expense_other', accountOverride: '4020' },
    )

    expect(result.error).toBeUndefined()
    const mappingArg = mockCreateJE.mock.calls[0][4] as {
      debit_account: string
      vat_lines: unknown[]
    }
    expect(mappingArg.debit_account).toBe('4020')
    expect(mappingArg.vat_lines).toEqual([])
  })

  it('returns 400 (never posts) when the override was deactivated after staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: { account_number: '4020', account_class: 4, is_active: false } })

    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'expense_other', vatTreatment: 'exempt', accountOverride: '4020' },
    )

    expect(result.status).toBe(400)
    expect(result.error).toMatch(/inaktivt/)
    expect(mockCreateJE).not.toHaveBeenCalled()
  })

  it('returns 400 when accountOverride is combined with category "private"', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'private', accountOverride: '4020' },
    )

    expect(result.status).toBe(400)
    expect(result.error).toMatch(/private/)
    expect(mockCreateJE).not.toHaveBeenCalled()
  })

  it('stornos a posted entry when the ignored-row constraint rejects the link', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow({ is_ignored: true }) })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'fp-1' }] })
    enqueue({
      data: null,
      error: {
        code: '23514',
        message:
          'new row for relation "transactions" violates check constraint "transactions_is_ignored_no_journal_entry"',
      },
    })

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'private' },
    )

    expect(result.status).toBe(409)
    expect(mockReverseOrphanedJE).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      'je-override-1',
      expect.any(String),
    )
  })

  it('uses a company-scoped CAS and stornos a concurrent loser', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'fp-1' }] })
    enqueue({ data: [] })

    const result = await categorizeMatchedTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { category: 'private' },
    )

    expect(result.status).toBe(409)
    expect(mockReverseOrphanedJE).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(
      expect.arrayContaining([
        { table: 'transactions', method: 'eq', args: ['id', TX_ID] },
        { table: 'transactions', method: 'eq', args: ['company_id', 'company-1'] },
        { table: 'transactions', method: 'is', args: ['journal_entry_id', null] },
      ]),
    )
  })
})
