/**
 * Issue #50: the skattekonto row "Moms juni" is booked first (D 2650 /
 * K 1630); the bank payment is then categorised straight to 2650. That
 * clears the moms twice, so the categorize door warns with the shared
 * duplicate code once its kontering is known, and books on the skattekonto
 * account without a word.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockCreateJE = vi.fn()
const mockAppend = vi.fn()
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/bookkeeping/transaction-entries', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/transaction-entries')>()),
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
  appendProcessingHistory: (...args: unknown[]) => mockAppend(...args),
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

import { categorizeMatchedTransaction, categorizeTransaction } from '../categorize-core'

type Enqueue = (r: { data?: unknown; error?: unknown }) => void

const TX_ID = '00000000-0000-4000-8000-0000000050a1'
const SKV_TEXT = 'SKATTEVERKET     BG 0000050501055 Bg-bet. via internet'

const txRow = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  company_id: 'company-1',
  date: '2026-07-10',
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

// The skattekonto row booked through 1630 earlier in the month.
const MOMS_ENTRY = {
  id: 'je-moms',
  entry_date: '2026-07-12',
  description: 'Skattekonto: Moms juni 2026',
  voucher_series: 'A',
  voucher_number: 12,
  source_type: 'system',
  reverses_id: null,
}

/** The kontering read: company settings, the cash-account fallback and the override's chart row. */
function enqueueKontering(enqueue: Enqueue, account: string) {
  enqueue({ data: settingsRow })
  enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
  enqueue({ data: { account_number: account, account_class: Number(account[0]), is_active: true } })
}

/** The skattekonto half's month read: the entries, then their tax and skattekonto lines. */
function enqueueMonth(enqueue: Enqueue, withMoms: boolean) {
  if (!withMoms) {
    enqueue({ data: [] })
    return
  }
  enqueue({ data: [MOMS_ENTRY] })
  enqueue({
    data: [
      { id: 'l-1', journal_entry_id: 'je-moms', account_number: '2650', debit_amount: 12225, credit_amount: 0 },
      { id: 'l-2', journal_entry_id: 'je-moms', account_number: '1630', debit_amount: 0, credit_amount: 12225 },
    ],
  })
}

function enqueueBooking(enqueue: Enqueue) {
  enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
  enqueue({ data: [txRow({ journal_entry_id: 'je-new' })] }) // transactions update
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockCreateJE.mockResolvedValue({ id: 'je-new' })
  mockAppend.mockResolvedValue(undefined)
})

describe('categorize: a tax account booked straight from the bank after the skattekonto booked it (issue #50)', () => {
  it('refuses the agent door with the skattekonto candidate and says to book on 1630', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueueKontering(enqueue, '2650')
    enqueueMonth(enqueue, true)

    const result = await categorizeMatchedTransaction(supabase as never, 'user-1', 'company-1', TX_ID, {
      category: 'expense_other',
      vatTreatment: 'exempt',
      accountOverride: '2650',
    })

    expect(result.status).toBe(409)
    expect(result.errorCode).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
    expect(result.error).toContain('verifikat A12 (2026-07-12)')
    expect(result.error).toContain('bokför transaktionen mot 1630 i stället')
    expect(mockCreateJE).not.toHaveBeenCalled()
  })

  it('books when no skattekonto verifikat of the month clears the tax', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueueKontering(enqueue, '2650')
    enqueueMonth(enqueue, false)
    enqueueBooking(enqueue)

    const result = await categorizeMatchedTransaction(supabase as never, 'user-1', 'company-1', TX_ID, {
      category: 'expense_other',
      vatTreatment: 'exempt',
      accountOverride: '2650',
    })

    expect(result.error).toBeUndefined()
    expect(mockCreateJE).toHaveBeenCalled()
  })

  it('books on the skattekonto account without reading the month at all', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueueKontering(enqueue, '1630')
    enqueueBooking(enqueue)

    const result = await categorizeMatchedTransaction(supabase as never, 'user-1', 'company-1', TX_ID, {
      category: 'expense_other',
      vatTreatment: 'exempt',
      accountOverride: '1630',
    })

    expect(result.error).toBeUndefined()
    expect(mockCreateJE).toHaveBeenCalled()
    expect(findCalls('journal_entries', 'gte')).toEqual([])
  })

  it('books over it on allow_duplicate and records the dismissal', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueueKontering(enqueue, '2650')
    enqueueMonth(enqueue, true)
    enqueueBooking(enqueue)

    const result = await categorizeMatchedTransaction(supabase as never, 'user-1', 'company-1', TX_ID, {
      category: 'expense_other',
      vatTreatment: 'exempt',
      accountOverride: '2650',
      allowDuplicate: true,
    })

    expect(result.error).toBeUndefined()
    expect(mockCreateJE).toHaveBeenCalled()
    expect(result.checks).toContainEqual({ id: 'duplicate', result: 'warn', detail: 'allow_duplicate:journal_entry:je-moms' })
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ dismissed_journal_entry_id: 'je-moms', via: 'allow_duplicate' }) }),
    )
  })

  it('books on force bound to the reviewed candidate (deferred past the bank-line halves)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    // The first guard call: no bank-line candidate, so the forced id is checked as a skattekonto candidate.
    enqueue({
      data: {
        ...MOMS_ENTRY,
        status: 'posted',
        journal_entry_lines: [{ account_number: '2650' }, { account_number: '1630' }],
      },
    })
    enqueueKontering(enqueue, '2650')
    enqueueMonth(enqueue, true)
    enqueueBooking(enqueue)

    const outcome = await categorizeTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      {
        is_business: true,
        category: 'expense_other',
        vat_treatment: 'exempt',
        account_override: '2650',
        force: true,
        expected_duplicate_journal_entry_id: 'je-moms',
      },
      { onBooked: 'refuse', invoiceMatchIntercept: false },
    )

    expect(outcome.ok).toBe(true)
    expect(mockCreateJE).toHaveBeenCalled()
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ dismissed_journal_entry_id: 'je-moms' }) }),
    )
  })

  it('refuses a force whose skattekonto candidate is gone once the kontering is known', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueue({
      data: {
        ...MOMS_ENTRY,
        status: 'posted',
        journal_entry_lines: [{ account_number: '2650' }, { account_number: '1630' }],
      },
    })
    enqueueKontering(enqueue, '2650')
    enqueueMonth(enqueue, false)

    const outcome = await categorizeTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      {
        is_business: true,
        category: 'expense_other',
        vat_treatment: 'exempt',
        account_override: '2650',
        force: true,
        expected_duplicate_journal_entry_id: 'je-moms',
      },
      { onBooked: 'refuse', invoiceMatchIntercept: false },
    )

    expect(outcome).toMatchObject({ ok: false, code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH' })
    expect(mockCreateJE).not.toHaveBeenCalled()
  })
})
