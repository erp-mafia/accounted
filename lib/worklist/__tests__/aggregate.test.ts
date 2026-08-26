import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../categories', () => ({
  countUnbookedTransactions: vi.fn().mockResolvedValue(4),
  countInboxDocuments: vi.fn().mockResolvedValue(6),
  countSuggestedMatches: vi.fn().mockResolvedValue(2),
  countSupplierInvoicesAwaitingApproval: vi.fn().mockResolvedValue(1),
  countVerifikatMissingDocument: vi.fn().mockResolvedValue(3),
  countOverdueInvoices: vi.fn().mockResolvedValue(5),
  countDeadlinesNeedingAction: vi.fn().mockResolvedValue(1),
  countPendingOperations: vi.fn().mockResolvedValue(2),
  countReconciliationDue: vi.fn().mockResolvedValue(1),
}))

import { getWorklistCounts } from '../aggregate'

const supabase = {} as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getWorklistCounts', () => {
  it('aggregates every category', async () => {
    const { counts } = await getWorklistCounts(supabase, 'company-1')
    expect(counts).toEqual({
      book_transaction: 4,
      inbox_document: 6,
      suggested_match: 2,
      supplier_invoice_approval: 1,
      verifikat_missing_document: 3,
      overdue_invoice: 5,
      deadline_action: 1,
      pending_operations: 2,
      reconciliation_due: 1,
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

  it('excludes suggested_match from the total (subset of book_transaction)', async () => {
    const { total } = await getWorklistCounts(supabase, 'company-1')
    // 4 + 6 + 1 + 3 + 5 + 1 + 2 + 1, without the 2 suggested matches.
    expect(total).toBe(23)
  })
})
