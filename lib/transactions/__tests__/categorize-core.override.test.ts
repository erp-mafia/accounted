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
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJE(...args),
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
})

describe('categorizeMatchedTransaction: accountOverride', () => {
  it('posts the entry with the override on the business side', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() }) // transactions select
    enqueue({ data: settingsRow }) // company_settings
    enqueue({ data: { account_number: '4020', account_class: 4, is_active: true } }) // override chart hit
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod: open period exists
    enqueue({ data: null }) // transactions update

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
    enqueue({ data: { account_number: '4020', account_class: 4, is_active: true } })
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
    enqueue({ data: null }) // transactions update

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

    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'private', accountOverride: '4020' },
    )

    expect(result.status).toBe(400)
    expect(result.error).toMatch(/private/)
    expect(mockCreateJE).not.toHaveBeenCalled()
  })
})
