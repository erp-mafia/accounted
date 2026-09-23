/**
 * gnubok_categorize_transaction / gnubok_bulk_book_inbox_items: the `category`
 * argument is required, and hosts don't always enforce inputSchema `required`.
 *
 * Issue #1662: a call carrying only account_override reached the enum check
 * and surfaced as 'Invalid category "undefined"'. These tests pin:
 *   - missing category -> a clear "category is required" error (before DB work),
 *   - an unknown category string -> the enum error, unchanged,
 *   - the happy path stages with the category intact.
 * Companion suite: categorize-account-override.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockDetectDup = vi.fn()
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))

import { tools } from '../server'

const categorize = tools.find((t) => t.name === 'gnubok_categorize_transaction')!
const bulkBookInbox = tools.find((t) => t.name === 'gnubok_bulk_book_inbox_items')!

const TX_ID = '00000000-0000-4000-8000-0000000000cc'

/** `transactions` row for categorizeTransactionCore's select('*'). Synthetic. */
const coreTxRow = () => ({
  id: TX_ID,
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
  is_business: true,
})

/** The narrower projection the tool re-fetches for the guard + title. */
const guardTxRow = () => ({
  description: 'SECOND HAND BUTIK',
  merchant_name: null,
  amount: -479,
  currency: 'SEK',
  amount_sek: -479,
  exchange_rate: 1,
  date: '2026-07-10',
  cash_account_id: null,
})

const settingsRow = { entity_type: 'aktiebolag', fiscal_year_start_month: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockDetectDup.mockResolvedValue(null)
})

describe('gnubok_categorize_transaction: category presence guard (#1662)', () => {
  it('declares category as required in the input schema', () => {
    const schema = categorize.inputSchema as { required?: string[] }
    expect(schema.required).toContain('category')
  })

  it('rejects a call with only account_override with a clear "category is required" error', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    let thrown: unknown
    try {
      await categorize.execute(
        { transaction_id: TX_ID, account_override: '4020' },
        'company-1',
        'user-1',
        supabase as never,
      )
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toMatch(
      /^category is required; account_override only overrides the category's default account/,
    )
    // Never the old 'Invalid category "undefined"' shape, and no DB work.
    expect(message).not.toMatch(/undefined/)
    expect(calls).toHaveLength(0)
  })

  it('rejects a non-string or blank category the same way', async () => {
    const { supabase } = createQueuedMockSupabase()
    for (const category of [42, '', '   ', null]) {
      await expect(
        categorize.execute(
          { transaction_id: TX_ID, category },
          'company-1',
          'user-1',
          supabase as never,
        ),
      ).rejects.toThrow(/category is required/)
    }
  })

  it('still returns the enum error for an unknown category string', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      categorize.execute(
        { transaction_id: TX_ID, category: 'expense_unicorns' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Invalid category "expense_unicorns"\. Valid categories:/)
  })

  it('happy path: a valid category stages with the category intact', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow() }) // core: transactions
    enqueue({ data: settingsRow }) // core: company_settings
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: guardTxRow() }) // tool: transactions re-fetch
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-cat-1' } }) // pending_operations insert

    const result = (await categorize.execute(
      { transaction_id: TX_ID, category: 'expense_other' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )) as { staged: boolean; operation_id?: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-cat-1')
    expect(result.preview.category).toBe('expense_other')

    const insertArgs = findCall('pending_operations', 'insert')
    expect(insertArgs).toBeDefined()
    const payload = (insertArgs as unknown[])[0] as { params?: { category?: string } }
    expect(payload.params?.category).toBe('expense_other')
  })
})

describe('gnubok_bulk_book_inbox_items: category guard at staging', () => {
  it('rejects a missing category before any DB work', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    await expect(
      bulkBookInbox.execute(
        { item_ids: ['i1'] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/^category is required/)
    expect(calls).toHaveLength(0)
  })

  it('rejects an unknown category string with the enum error', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      bulkBookInbox.execute(
        { item_ids: ['i1'], category: 'expense_unicorns' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Invalid category "expense_unicorns"/)
  })
})
