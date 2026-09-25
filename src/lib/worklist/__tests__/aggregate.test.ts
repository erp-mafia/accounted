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
  countOverdueInvoices: vi.fn().mockResolvedValue(5),
  countDeadlinesNeedingAction: vi.fn().mockResolvedValue(1),
  countPendingOperations: vi.fn().mockResolvedValue(2),
  countReconciliationDue: vi.fn().mockResolvedValue(1),
  countExpensePayoutsDue: vi.fn().mockResolvedValue(2),
  countSkattekontoPaymentDue: vi.fn().mockResolvedValue(1),
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
      reconciliation_due: 1,
      expense_payout: 2,
      skattekonto_payment_due: 1,
      document_relevance: 0,
      document_unclassified: 0,
      document_field_review: 0,
      agreement_payment_missed: 0,
      arkiv_finding: 0,
    })
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
    expect(off.total).toBe(33)
    expect(c.countHeldDocuments).not.toHaveBeenCalled()
    expect(c.countArkivFindings).not.toHaveBeenCalled()

    // The section open: held and untyped documents count, the brain rows still do not.
    process.env.ARKIV_COMPANY_IDS = 'company-1'
    const section = await getWorklistCounts(supabase, 'company-1')
    expect(section.counts).toMatchObject({ document_relevance: 2, document_unclassified: 3, document_field_review: 0, agreement_payment_missed: 0, arkiv_finding: 0 })
    expect(section.total).toBe(38)
    expect(c.countDocumentFieldReviews).not.toHaveBeenCalled()

    // The brain too: everything counts.
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
    const brain = await getWorklistCounts(supabase, 'company-1')
    expect(brain.counts).toMatchObject({ document_relevance: 2, document_unclassified: 3, document_field_review: 4, agreement_payment_missed: 5, arkiv_finding: 6 })
    expect(brain.total).toBe(53)
  })

  it('excludes suggested_match from the total (subset of book_transaction)', async () => {
    const { total } = await getWorklistCounts(supabase, 'company-1')
    // 4 + 7 + 6 + 1 + 3 + 5 + 1 + 2 + 1 + 2 (people owed for utlägg) + 1
    // (skattekonto payment), without the 2 suggested matches.
    expect(total).toBe(33)
  })
})
