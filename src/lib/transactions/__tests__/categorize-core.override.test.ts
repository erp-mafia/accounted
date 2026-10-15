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
import { recordDecisions } from '@/lib/suggestion-log/record'

const mockCreateJE = vi.fn()
const mockReverseOrphanedJE = vi.fn()
// suggestion_log is recorded around every booking; its own reads and writes
// are covered in lib/suggestion-log, not by this file's queued client.
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))

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

// The service's own checks that have their own tests: the chart
// pre-validation, the period-lock pre-check and the merchant-rule learning.
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/bookkeeping/mapping-engine', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/mapping-engine')>()),
  saveUserMappingRule: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
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
    // checkPeriodLock is mocked open (issue #1661's pre-check reads nothing here).
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

  it('records the decision with the proposal the agent booked from', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: settingsRow })
    enqueue({ data: [] })
    enqueue({ data: { account_number: '4020', account_class: 4, is_active: true } })
    enqueue({ data: [{ id: 'fp-1' }] })
    enqueue({ data: [{ id: TX_ID }] })

    await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'expense_other', vatTreatment: 'exempt', accountOverride: '4020', proposalId: 'assistant:x' },
    )

    expect(vi.mocked(recordDecisions)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ companyId: 'company-1' }),
      [{
        transactionId: TX_ID,
        actedOn: 'assistant:x',
        final: expect.objectContaining({
          journal_entry_id: 'je-override-1',
          account: '4020',
          booking: { kind: 'account', account: '4020', vat_treatment: 'exempt', category: 'expense_other' },
        }),
        // The approval door runs no invoice-match intercept, so none is recorded.
        checks: [
          { id: 'already_booked', result: 'pass', detail: null },
          { id: 'duplicate', result: 'pass', detail: null },
          { id: 'counter_legs', result: 'pass', detail: null },
          { id: 'chart', result: 'pass', detail: null },
          { id: 'period_lock', result: 'pass', detail: null },
        ],
      }],
      'user-1',
    )
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

  // #2919: the approved kind reaches the posted verifikat, and an override
  // onto a basis account (the cost line reports ruta 22 itself) gets no
  // second basis pair. crm#1096: nor does a cost account whose momskod in
  // the kontoplan reports ruta 20-24 itself.
  it('posts the reverse-charge basis on the approved kind, and none on a basis-account override', async () => {
    const post = async (accountOverride?: string, momskoder: Array<Record<string, unknown>> = []) => {
      mockCreateJE.mockClear()
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: txRow({ amount: -250, amount_sek: -250 }) })
      enqueue({ data: settingsRow })
      enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
      if (accountOverride) {
        enqueue({ data: { account_number: accountOverride, account_class: 4, is_active: true } })
      }
      enqueue({ data: momskoder }) // reconcileRcBasisWithChart: the company's momskoder
      enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
      enqueue({ data: [{ id: TX_ID }] }) // transactions update
      const result = await categorizeMatchedTransaction(
        supabase as never, 'user-1', 'company-1', TX_ID,
        { category: 'expense_software', vatTreatment: 'reverse_charge', reverseChargeKind: 'non_eu_services', accountOverride },
      )
      expect(result.error).toBeUndefined()
      return (mockCreateJE.mock.calls[0][4] as { vat_lines: Array<{ account_number: string }> })
        .vat_lines.map((l) => l.account_number)
    }

    expect(await post()).toEqual(['2645', '2614', '4531', '4598'])
    expect(await post('4531')).toEqual(['2645', '2614'])
    expect(await post(undefined, [{ account_number: '5420', default_vat_treatment: 'reverse_charge_non_eu_services' }]))
      .toEqual(['2645', '2614'])
    expect(await post('4056', [{ account_number: '4056', default_vat_treatment: 'reverse_charge_eu_goods' }]))
      .toEqual(['2645', '2614'])
  })

  it('reads the momskoder through a loader the caller shares (the bulk driver), not once per booking', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow({ amount: -250, amount_sek: -250 }) })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
    enqueue({ data: [{ id: TX_ID }] }) // transactions update
    const loadChart = vi.fn(async () => new Map([['5420', { default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: null }]]))
    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'expense_software', vatTreatment: 'reverse_charge', loadChart },
    )
    expect(result.error).toBeUndefined()
    expect(loadChart).toHaveBeenCalledTimes(1)
    expect((mockCreateJE.mock.calls[0][4] as { vat_lines: Array<{ account_number: string }> })
      .vat_lines.map((l) => l.account_number)).toEqual(['2645', '2614'])
    expect(supabase.from).not.toHaveBeenCalledWith('chart_of_accounts')
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
    // checkPeriodLock is mocked open, so the constraint error below is the
    // update's own answer.
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
