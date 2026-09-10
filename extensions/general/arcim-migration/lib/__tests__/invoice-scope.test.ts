import { describe, it, expect } from 'vitest'
import { fiscalYearScopeFromImports, invoiceWithinScope } from '../invoice-scope'

/**
 * #2469: the migration used to pay a detail fetch for every invoice in the
 * provider's register, every year, and ran out of the function's 300 s on a
 * large one. Paid invoices outside the SIE-imported fiscal years have no
 * ledger here and are declined before hydration; open ones are kept from
 * any year.
 */

const SCOPE = { start: '2026-01-01', end: '2026-12-31' }

function dto(issueDate: string, paid: boolean) {
  return { issueDate, paymentStatus: { paid, balance: { value: paid ? 0 : 100, currencyCode: 'SEK' } } }
}

describe('invoiceWithinScope', () => {
  it('keeps a paid invoice issued inside the scope', () => {
    expect(invoiceWithinScope(dto('2026-03-14', true), SCOPE)).toBe(true)
  })

  it('declines a paid invoice issued before the scope', () => {
    expect(invoiceWithinScope(dto('2025-11-30', true), SCOPE)).toBe(false)
  })

  it('declines a paid invoice issued after the scope', () => {
    expect(invoiceWithinScope(dto('2027-01-02', true), SCOPE)).toBe(false)
  })

  it('keeps an unpaid invoice from any year', () => {
    expect(invoiceWithinScope(dto('2024-06-01', false), SCOPE)).toBe(true)
  })

  it('is inclusive at both bounds', () => {
    expect(invoiceWithinScope(dto('2026-01-01', true), SCOPE)).toBe(true)
    expect(invoiceWithinScope(dto('2026-12-31', true), SCOPE)).toBe(true)
  })

  it('reads an ISO timestamp by its date part', () => {
    expect(invoiceWithinScope(dto('2025-12-31T23:00:00Z', true), SCOPE)).toBe(false)
  })

  it('keeps everything when there is no scope', () => {
    expect(invoiceWithinScope(dto('2019-01-01', true), null)).toBe(true)
    expect(invoiceWithinScope(dto('2019-01-01', true), undefined)).toBe(true)
  })

  it('keeps an invoice whose issue date is unreadable rather than dropping it silently', () => {
    expect(invoiceWithinScope(dto('', true), SCOPE)).toBe(true)
    expect(invoiceWithinScope(dto('14/03/2025', true), SCOPE)).toBe(true)
  })
})

describe('fiscalYearScopeFromImports', () => {
  it('spans the earliest start to the latest end across imports', () => {
    expect(fiscalYearScopeFromImports([
      { fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' },
      { fiscal_year_start: '2025-01-01', fiscal_year_end: '2025-12-31' },
    ])).toEqual({ start: '2025-01-01', end: '2026-12-31' })
  })

  it('returns null with no imports, so nothing is filtered', () => {
    expect(fiscalYearScopeFromImports([])).toBeNull()
    expect(fiscalYearScopeFromImports(null)).toBeNull()
  })

  it('returns null when an import lacks its bounds rather than guessing', () => {
    expect(fiscalYearScopeFromImports([
      { fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' },
      { fiscal_year_start: null, fiscal_year_end: null },
    ])).toBeNull()
  })
})
