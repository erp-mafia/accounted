/**
 * gnubok_categorize_transaction: the account_override parameter.
 *
 * Custom accounts (e.g. VMB accounts like 4020) are outside the fixed
 * category → account maps, so account_override is the ONLY path by which the
 * MCP categorize surface can book on them. These tests pin:
 *   - staging-time validation (unknown / inactive / malformed / private),
 *   - the override landing in both the staged params (for the commit
 *     executor) and the preview (for the approver),
 * Companion suites:
 *   - lib/bookkeeping/__tests__/account-override.test.ts (the shared helper)
 *   - lib/transactions/__tests__/categorize-core.override.test.ts (commit path)
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

const TX_ID = '00000000-0000-4000-8000-0000000000bb'

/** `transactions` row for categorizeTransactionCore's select('*'). Synthetic. */
const coreTxRow = (over: Record<string, unknown> = {}) => ({
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
  ...over,
})

/** The narrower projection the tool re-fetches for the guard + title. */
const guardTxRow = (over: Record<string, unknown> = {}) => ({
  description: 'SECOND HAND BUTIK',
  merchant_name: null,
  amount: -479,
  currency: 'SEK',
  amount_sek: -479,
  exchange_rate: 1,
  date: '2026-07-10',
  cash_account_id: null,
  ...over,
})

const settingsRow = { entity_type: 'aktiebolag', fiscal_year_start_month: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockDetectDup.mockResolvedValue(null)
})

describe('gnubok_categorize_transaction: account_override', () => {
  it('declares account_override in the input schema with a 4-digit pattern', () => {
    const schema = categorize.inputSchema as {
      properties: { account_override?: { type: string; pattern?: string } }
      required?: string[]
    }
    expect(schema.properties.account_override).toBeDefined()
    expect(schema.properties.account_override?.type).toBe('string')
    expect(schema.properties.account_override?.pattern).toBe('^\\d{4}$')
    expect(schema.required ?? []).not.toContain('account_override')
  })

  it('rejects a malformed override before any DB work', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      categorize.execute(
        { transaction_id: TX_ID, category: 'expense_other', account_override: '40a0' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/4 digits/)
  })

  it('rejects at staging when the override account is not in the chart', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow() }) // core: transactions
    enqueue({ data: settingsRow }) // core: company_settings
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: null }) // applyAccountOverride: chart_of_accounts miss

    await expect(
      categorize.execute(
        { transaction_id: TX_ID, category: 'expense_other', account_override: '4020' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/finns inte i kontoplanen/)
  })

  it('rejects at staging when the override account is inactive', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow() })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: { account_number: '4020', account_class: 4, is_active: false } })

    await expect(
      categorize.execute(
        { transaction_id: TX_ID, category: 'expense_other', account_override: '4020' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/inaktivt/)
  })

  it('rejects account_override combined with category "private"', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow() })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    await expect(
      categorize.execute(
        { transaction_id: TX_ID, category: 'private', account_override: '4020' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/private/)
  })

  it('stages with the override in params AND preview when the account is active', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow() }) // core: transactions
    enqueue({ data: settingsRow }) // core: company_settings
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: { account_number: '4020', account_class: 4, is_active: true } }) // override chart hit
    enqueue({ data: guardTxRow() }) // tool: transactions re-fetch
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-override-1' } }) // pending_operations insert

    const result = (await categorize.execute(
      {
        transaction_id: TX_ID,
        category: 'expense_other',
        vat_treatment: 'exempt',
        account_override: '4020',
      },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )) as { staged: boolean; operation_id?: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-override-1')
    // The preview must show the account that will actually be posted, not the
    // category default (6991 for expense_other).
    expect(result.preview.debit_account).toBe('4020')
    expect(result.preview.account_override).toBe('4020')

    // The staged params must carry the override so the commit executor books
    // on it after approval.
    const insertArgs = findCall('pending_operations', 'insert')
    expect(insertArgs).toBeDefined()
    const payload = (insertArgs as unknown[])[0] as { params?: { account_override?: string | null } }
    expect(payload.params?.account_override).toBe('4020')
  })
})
