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

function dto(issueDate: string, paid: boolean, lastPaymentDate?: string) {
  return { issueDate, paymentStatus: { paid, balance: { value: paid ? 0 : 100, currencyCode: 'SEK' }, lastPaymentDate } }
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

  it('keeps a prior-year invoice settled inside the scope: it backs the 1510/2440 opening balance', () => {
    expect(invoiceWithinScope(dto('2025-12-20', true, '2026-01-15'), SCOPE)).toBe(true)
    expect(invoiceWithinScope(dto('2025-12-20', true, '2026-01-01'), SCOPE)).toBe(true)
  })

  it('keeps a prior-year invoice settled after the scope for the same reason', () => {
    expect(invoiceWithinScope(dto('2025-12-20', true, '2027-02-01'), SCOPE)).toBe(true)
  })

  it('declines a prior-year invoice that was also settled before the scope', () => {
    expect(invoiceWithinScope(dto('2025-06-20', true, '2025-07-15'), SCOPE)).toBe(false)
  })

  it('lets the issue date alone decide when the provider gave no payment date', () => {
    expect(invoiceWithinScope(dto('2025-12-20', true, undefined), SCOPE)).toBe(false)
    expect(invoiceWithinScope(dto('2025-12-20', true, 'okänt'), SCOPE)).toBe(false)
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

  it('treats a date-shaped value that is not a calendar day as unreadable', () => {
    expect(invoiceWithinScope(dto('2025-13-01', true), SCOPE)).toBe(true)
    expect(invoiceWithinScope(dto('2025-02-30', true), SCOPE)).toBe(true)
    // A real day before the scope still declines, so the check is not a blanket keep.
    expect(invoiceWithinScope(dto('2025-02-28', true), SCOPE)).toBe(false)
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
