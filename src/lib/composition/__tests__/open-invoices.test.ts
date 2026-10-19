/**
 * The bank side's open-invoice plug-in point is static wiring: each member
 * hands its arguments, unchanged, to the function the bank side called
 * directly before the seam existed, and gives back what it returns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loadPool, suggestParts, findSuggestion } = vi.hoisted(() => ({
  loadPool: vi.fn(),
  suggestParts: vi.fn(),
  findSuggestion: vi.fn(),
}))
vi.mock('@/lib/invoices/invoice-matching', () => ({ loadInvoiceMatchPool: loadPool }))
vi.mock('@/lib/invoices/part-invoice-suggestions', () => ({ suggestPartInvoices: suggestParts }))
vi.mock('@/lib/invoices/invoice-match-suggestion', () => ({ findInvoiceMatchSuggestion: findSuggestion }))

import { OPEN_INVOICES } from '../open-invoices'

describe('OPEN_INVOICES', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is frozen', () => {
    expect(Object.isFrozen(OPEN_INVOICES)).toBe(true)
  })

  it('reads the customer invoice pool with loadInvoiceMatchPool', async () => {
    const pool = { invoices: [] }
    loadPool.mockResolvedValue(pool)
    const supabase = {} as never
    await expect(OPEN_INVOICES.loadCustomerInvoicePool(supabase, 'company-1')).resolves.toBe(pool)
    expect(loadPool).toHaveBeenCalledWith(supabase, 'company-1')
  })

  it('suggests split parts with suggestPartInvoices', () => {
    const suggestions = [{ seq: 1, suggested_invoice_id: null, suggested_supplier_invoice_id: null, suggestion_reason: null }]
    suggestParts.mockReturnValue(suggestions)
    const input = { parentAmount: 1, parts: [], customerInvoices: [], supplierInvoices: [] }
    expect(OPEN_INVOICES.suggestSplitParts(input)).toBe(suggestions)
    expect(suggestParts).toHaveBeenCalledWith(input)
  })

  it('answers the categorize intercept with findInvoiceMatchSuggestion', async () => {
    const refusal = { code: 'TX_CATEGORIZE_SUGGEST_CI_MATCH', details: { candidates: [] } }
    findSuggestion.mockResolvedValue(refusal)
    const supabase = {} as never
    const log = { warn: vi.fn() } as never
    const input = {
      transaction: { date: '2026-05-12', amount: 100, currency: 'SEK' },
      debitAccount: '1930',
      creditAccount: '1510',
      isBusiness: true,
    }
    await expect(OPEN_INVOICES.findCategorizeInterception(supabase, 'company-1', input, log)).resolves.toBe(refusal)
    expect(findSuggestion).toHaveBeenCalledWith(supabase, 'company-1', input, log)
  })
})
