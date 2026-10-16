/**
 * crm#1275: a payment to Skatteverket was booked under "Resor" (5890 with 25 %
 * moms). A payment to Skatteverket moves money to the skattekonto and carries
 * no moms, so the categorize path refuses any booking that would post moms on
 * one, whatever category, template or account produced it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockCreateJE = vi.fn()
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))
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

const TX_ID = '00000000-0000-4000-8000-0000000012a5'
const SKV_TEXT = 'SKATTEVERKET     BG 0000050501055 Bg-bet. via internet'

const txRow = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  company_id: 'company-1',
  date: '2026-10-13',
  amount: -12225,
  currency: 'SEK',
  amount_sek: -12225,
  exchange_rate: 1,
  description: SKV_TEXT,
  original_description: SKV_TEXT,
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

describe('categorizeMatchedTransaction: no moms on a payment to Skatteverket', () => {
  it('refuses the travel category with 25 % moms on a Skatteverket payment', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() }) // transactions select
    enqueue({ data: settingsRow }) // company_settings
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'expense_travel', vatTreatment: 'standard_25' },
    )

    expect(result.status).toBe(400)
    expect(result.error).toMatch(/Skatteverket har ingen moms/)
    expect(mockCreateJE).not.toHaveBeenCalled()
  })

  it('books the same line on the skattekonto without moms', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount fallback -> 1930
    enqueue({ data: { account_number: '1630', account_class: 1, is_active: true } }) // override chart hit
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
    enqueue({ data: [txRow({ journal_entry_id: 'je-1' })] }) // transactions update

    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'expense_other', vatTreatment: 'exempt', accountOverride: '1630' },
    )

    expect(result.error).toBeUndefined()
    expect(mockCreateJE).toHaveBeenCalled()
  })

  it('still books moms on an ordinary purchase', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow({ description: 'SJ AB', original_description: 'SJ AB', amount: -1250, amount_sek: -1250 }) })
    enqueue({ data: settingsRow })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
    enqueue({ data: [txRow({ journal_entry_id: 'je-1' })] }) // transactions update

    const result = await categorizeMatchedTransaction(
      supabase as never, 'user-1', 'company-1', TX_ID,
      { category: 'expense_travel', vatTreatment: 'reduced_6' },
    )

    expect(result.error).toBeUndefined()
    expect(mockCreateJE).toHaveBeenCalled()
  })
})
