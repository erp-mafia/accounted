import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../categories', () => ({
  countUnbookedTransactions: vi.fn().mockResolvedValue(4),
  countUnbookedSkattekontoRows: vi.fn().mockResolvedValue(7),
  countInboxDocuments: vi.fn().mockResolvedValue(6),
  countSuggestedMatches: vi.fn().mockResolvedValue(2),
  countSupplierInvoicesAwaitingApproval: vi.fn().mockResolvedValue(1),
  countVerifikatMissingDocument: vi.fn().mockResolvedValue(3),
  countHeldDocuments: vi.fn().mockResolvedValue(0),
  countUnclassifiedDocuments: vi.fn().mockResolvedValue(0),
  countDocumentFieldReviews: vi.fn().mockResolvedValue(0),
  countMissedAgreementPayments: vi.fn().mockResolvedValue(0),
  countArkivFindings: vi.fn().mockResolvedValue(0),
  getOverdueInvoicesDue: vi.fn().mockResolvedValue({
    count: 5,
    remaining_sek: 12500,
    unconverted_count: 0,
    oldest_due_date: '2026-09-01',
    oldest_days_overdue: 42,
  }),
  countDeadlinesNeedingAction: vi.fn().mockResolvedValue(1),
  countPendingOperations: vi.fn().mockResolvedValue(2),
  countReconciliationDue: vi.fn().mockResolvedValue(1),
  countExpensePayoutsDue: vi.fn().mockResolvedValue(2),
  countSkattekontoPaymentDue: vi.fn().mockResolvedValue(1),
  countFailedPeppolDeliveries: vi.fn().mockResolvedValue(2),
  countCollectionDecisionsAndBatch: vi.fn().mockResolvedValue({ decision: 0, batchReady: 0 }),
  countCollectionAttention: vi.fn().mockResolvedValue(0),
  countCollectionSettlementsToBook: vi.fn().mockResolvedValue(0),
  countCollectedPaymentsToBook: vi.fn().mockResolvedValue(0),
  countBankSwitchDue: vi.fn().mockResolvedValue(0),
  countPaymentsVerificationDue: vi.fn().mockResolvedValue(0),
  countSupplierPayeeChangesDue: vi.fn().mockResolvedValue(0),
  countDocumentsToSign: vi.fn().mockResolvedValue(0),
}))

vi.mock('@/lib/suggestions/list', () => ({
  listOpenSuggestions: vi.fn().mockResolvedValue([]),
}))

import { getWorklistCounts } from '../aggregate'

const supabase = {} as SupabaseClient

const savedEnv = { section: process.env.ARKIV_COMPANY_IDS, brain: process.env.ARKIV_BRAIN_COMPANY_IDS }

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.ARKIV_COMPANY_IDS
  delete process.env.ARKIV_BRAIN_COMPANY_IDS
})

afterEach(() => {
  if (savedEnv.section === undefined) delete process.env.ARKIV_COMPANY_IDS
  else process.env.ARKIV_COMPANY_IDS = savedEnv.section
  if (savedEnv.brain === undefined) delete process.env.ARKIV_BRAIN_COMPANY_IDS
  else process.env.ARKIV_BRAIN_COMPANY_IDS = savedEnv.brain
})

describe('getWorklistCounts', () => {
  it('aggregates every category', async () => {
    const { counts } = await getWorklistCounts(supabase, 'company-1')
    expect(counts).toEqual({
      book_transaction: 4,
      book_skattekonto: 7,
      inbox_document: 6,
      suggested_match: 2,
      supplier_invoice_approval: 1,
      verifikat_missing_document: 3,
      overdue_invoice: 5,
      deadline_action: 1,
      pending_operations: 2,
      suggestion: 0,
      reconciliation_due: 1,
      expense_payout: 2,
      skattekonto_payment_due: 1,
      document_relevance: 0,
      document_unclassified: 0,
      document_field_review: 0,
      agreement_payment_missed: 0,
      arkiv_finding: 0,
      peppol_delivery_failed: 2,
      collection_decision: 0,
      collection_attention: 0,
      collection_settlements_to_book: 0,
      collected_payments_to_book: 0,
      collection_batch_ready: 0,
      bank_switch: 0,
      payments_verification_renewal: 0,
      supplier_payee_change: 0,
      documents_to_sign: 0,
    })
  })

  it('says where the company\'s inbox lives: the new Inkorg in the rollout, else the workspace', async () => {
    const saved = process.env.INKORG_V2_COMPANY_IDS
    try {
      process.env.INKORG_V2_COMPANY_IDS = 'company-1'
      expect((await getWorklistCounts(supabase, 'company-1')).inboxHref).toBe('/inkorg')
      delete process.env.INKORG_V2_COMPANY_IDS
      expect((await getWorklistCounts(supabase, 'company-1')).inboxHref).toBe('/e/general/invoice-inbox')
    } finally {
      if (saved === undefined) delete process.env.INKORG_V2_COMPANY_IDS
      else process.env.INKORG_V2_COMPANY_IDS = saved
    }
  })

  it('counts the open suggestions into the total, and takes the count from a caller-supplied list', async () => {
    const { listOpenSuggestions } = await import('@/lib/suggestions/list')
    vi.mocked(listOpenSuggestions).mockResolvedValueOnce([{ suggestion_id: 's1' }, { suggestion_id: 's2' }] as never[])
    const first = await getWorklistCounts(supabase, 'company-1')
    expect(first.counts.suggestion).toBe(2)
    expect(first.total).toBe(33)
    expect(listOpenSuggestions).toHaveBeenCalledWith(supabase, 'company-1')
    vi.mocked(listOpenSuggestions).mockClear()
    const second = await getWorklistCounts(supabase, 'company-1', { openSuggestions: Promise.resolve([{ suggestion_id: 's1' }] as never[]) })
    expect(second.counts.suggestion).toBe(1)
    expect(listOpenSuggestions).not.toHaveBeenCalled()
  })

  it('counts the bank connections still to switch into the total, and takes the count from a caller-supplied list', async () => {
    const { countBankSwitchDue } = await import('../categories')
    vi.mocked(countBankSwitchDue).mockResolvedValueOnce(2)
    const first = await getWorklistCounts(supabase, 'company-1')
    expect(first.counts.bank_switch).toBe(2)
    expect(first.total).toBe(33)
    expect(countBankSwitchDue).toHaveBeenCalledWith(supabase, 'company-1')
    vi.mocked(countBankSwitchDue).mockClear()
    const due = [{ connection_id: 'c1' }] as never[]
    const second = await getWorklistCounts(supabase, 'company-1', { bankSwitchDue: Promise.resolve(due) })
    expect(second.counts.bank_switch).toBe(1)
    expect(countBankSwitchDue).not.toHaveBeenCalled()
  })

  it('counts payouts and collected payments waiting in Avräkningar into the total', async () => {
    const { countCollectionSettlementsToBook, countCollectedPaymentsToBook } = await import('../categories')
    vi.mocked(countCollectionSettlementsToBook).mockResolvedValueOnce(2)
    vi.mocked(countCollectedPaymentsToBook).mockResolvedValueOnce(3)
    const { counts, total } = await getWorklistCounts(supabase, 'company-1')
    expect(counts.collection_settlements_to_book).toBe(2)
    expect(counts.collected_payments_to_book).toBe(3)
    expect(total).toBe(36)
    expect(countCollectionSettlementsToBook).toHaveBeenCalledWith(supabase, 'company-1')
    expect(countCollectedPaymentsToBook).toHaveBeenCalledWith(supabase, 'company-1')
  })

  it('counts collection decisions and collections attention into the total', async () => {
    const { countCollectionDecisionsAndBatch, countCollectionAttention } = await import('../categories')
    vi.mocked(countCollectionDecisionsAndBatch).mockResolvedValueOnce({ decision: 2, batchReady: 0 })
    vi.mocked(countCollectionAttention).mockResolvedValueOnce(1)
    const { counts, total } = await getWorklistCounts(supabase, 'company-1')
    expect(counts.collection_decision).toBe(2)
    expect(counts.collection_attention).toBe(1)
    expect(total).toBe(34)
    expect(countCollectionDecisionsAndBatch).toHaveBeenCalledWith(supabase, 'company-1')
  })

  it('counts the pending collections batch items into the total, on the session client', async () => {
    const { countCollectionDecisionsAndBatch } = await import('../categories')
    vi.mocked(countCollectionDecisionsAndBatch).mockResolvedValueOnce({ decision: 1, batchReady: 4 })
    const { counts, total } = await getWorklistCounts(supabase, 'company-1')
    expect(counts.collection_batch_ready).toBe(4)
    expect(counts.collection_decision).toBe(1)
    expect(total).toBe(36)
    expect(countCollectionDecisionsAndBatch).toHaveBeenCalledTimes(1)
    expect(countCollectionDecisionsAndBatch).toHaveBeenCalledWith(supabase, 'company-1')
  })

  it('counts failed Peppol deliveries on the caller session client, like every other category', async () => {
    const { countFailedPeppolDeliveries } = await import('../categories')
    await getWorklistCounts(supabase, 'company-1')
    expect(countFailedPeppolDeliveries).toHaveBeenCalledWith(supabase, 'company-1')
  })

  it('takes the suggested-match count from a caller-supplied list instead of rescanning', async () => {
    const { countSuggestedMatches } = await import('../categories')
    const matches = [{ transactionId: 't1' }, { transactionId: 't2' }, { transactionId: 't3' }] as never[]
    const { counts } = await getWorklistCounts(supabase, 'company-1', {
      suggestedMatches: Promise.resolve(matches),
    })
    expect(counts.suggested_match).toBe(3)
    expect(countSuggestedMatches).not.toHaveBeenCalled()
  })

  it('takes the expense-payout count from a caller-supplied list instead of rescanning', async () => {
    const { countExpensePayoutsDue } = await import('../categories')
    const people = [{ key: 'owner:Anna' }, { key: 'emp-1' }, { key: 'emp-2' }] as never[]
    const { counts } = await getWorklistCounts(supabase, 'company-1', {
      expensePayoutsDue: Promise.resolve(people),
    })
    expect(counts.expense_payout).toBe(3)
    expect(countExpensePayoutsDue).not.toHaveBeenCalled()
  })

  it('takes the skattekonto payment count from a caller-supplied value instead of rescanning', async () => {
    const { countSkattekontoPaymentDue } = await import('../categories')
    const due = { due: '2026-09-12', amount: 1000 } as never
    const withDue = await getWorklistCounts(supabase, 'company-1', {
      skattekontoPaymentDue: Promise.resolve(due),
    })
    expect(withDue.counts.skattekonto_payment_due).toBe(1)
    // null is a value ("nothing to pay in"), not an absent option.
    const without = await getWorklistCounts(supabase, 'company-1', { skattekontoPaymentDue: null })
    expect(without.counts.skattekonto_payment_due).toBe(0)
    expect(countSkattekontoPaymentDue).not.toHaveBeenCalled()
  })

  it('does not count the Dokument rows for a company outside the section, nor the brain rows outside the brain', async () => {
    const c = await import('../categories')
    vi.mocked(c.countHeldDocuments).mockResolvedValue(2)
    vi.mocked(c.countUnclassifiedDocuments).mockResolvedValue(3)
    vi.mocked(c.countDocumentFieldReviews).mockResolvedValue(4)
    vi.mocked(c.countMissedAgreementPayments).mockResolvedValue(5)
    vi.mocked(c.countArkivFindings).mockResolvedValue(6)

    // Neither flag: every arkiv row is 0 and no query runs, the pages they lead to are 404 here.
    const off = await getWorklistCounts(supabase, 'company-1')
    expect(off.counts).toMatchObject({ document_relevance: 0, document_unclassified: 0, document_field_review: 0, agreement_payment_missed: 0, arkiv_finding: 0 })
    expect(off.total).toBe(31)
    expect(c.countHeldDocuments).not.toHaveBeenCalled()
    expect(c.countArkivFindings).not.toHaveBeenCalled()

    // The section open: held and untyped documents count, the brain rows still do not.
    process.env.ARKIV_COMPANY_IDS = 'company-1'
    const section = await getWorklistCounts(supabase, 'company-1')
    expect(section.counts).toMatchObject({ document_relevance: 2, document_unclassified: 3, document_field_review: 0, agreement_payment_missed: 0, arkiv_finding: 0 })
    expect(section.total).toBe(36)
    expect(c.countDocumentFieldReviews).not.toHaveBeenCalled()

    // The brain too: everything counts.
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
    const brain = await getWorklistCounts(supabase, 'company-1')
    expect(brain.counts).toMatchObject({ document_relevance: 2, document_unclassified: 3, document_field_review: 4, agreement_payment_missed: 5, arkiv_finding: 6 })
    expect(brain.total).toBe(51)
  })

  it('excludes suggested_match from the total (subset of book_transaction)', async () => {
    const { total } = await getWorklistCounts(supabase, 'company-1')
    // 4 + 7 + 6 + 1 + 3 + 1 (the overdue group) + 1 + 2 + 1 + 2 (people
    // owed for utlägg) + 1 (skattekonto payment) + 2 (failed Peppol
    // deliveries), without the 2 suggested matches.
    expect(total).toBe(31)
  })

  it('takes the overdue customer invoices as ONE item: the count says how many, the total adds 1 (crm#1084)', async () => {
    const { getOverdueInvoicesDue } = await import('../categories')
    const group = { count: 896, remaining_sek: 1_000_000, unconverted_count: 2, oldest_due_date: '2025-01-31', oldest_days_overdue: 620 }
    vi.mocked(getOverdueInvoicesDue).mockResolvedValueOnce(group)
    const many = await getWorklistCounts(supabase, 'company-1')
    expect(many.counts.overdue_invoice).toBe(896)
    expect(many.total).toBe(31)
    // The row's facts travel with the counts, so a refetch updates both.
    expect(many.overdueInvoices).toEqual(group)
    expect(getOverdueInvoicesDue).toHaveBeenCalledWith(supabase, 'company-1')

    vi.mocked(getOverdueInvoicesDue).mockResolvedValueOnce(null)
    const none = await getWorklistCounts(supabase, 'company-1')
    expect(none.counts.overdue_invoice).toBe(0)
    expect(none.total).toBe(30)
    expect(none.overdueInvoices).toBeNull()
  })
})
