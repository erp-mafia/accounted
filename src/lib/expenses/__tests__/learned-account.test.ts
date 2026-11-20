import { describe, it, expect } from 'vitest'
import { learnedExpenseAccount, merchantKey } from '../learned-account'

const claim = (description: string, expense_account: string, created_at: string) => ({ description, expense_account, created_at })

describe('learnedExpenseAccount (PH 101: the utlägg dialog opened with an empty cost account on every receipt)', () => {
  it("proposes the account the company's history books the counterparty on first, as Bokför direkt does", () => {
    expect(
      learnedExpenseAccount({ templateAccount: '5460', merchant: 'Clas Ohlson', claims: [claim('Clas Ohlson', '5410', '2026-10-01T10:00:00Z')] }),
    ).toEqual({ account: '5460', basis: 'counterparty' })
  })

  it('else the account the latest utlägg for the same merchant was booked on', () => {
    const claims = [
      claim('Clas Ohlson', '5410', '2026-09-01T10:00:00Z'),
      claim('clas  ohlson ', '5460', '2026-10-01T10:00:00Z'),
      claim('Biltema', '5611', '2026-10-20T10:00:00Z'),
    ]
    expect(learnedExpenseAccount({ templateAccount: null, merchant: 'CLAS OHLSON', claims })).toEqual({ account: '5460', basis: 'previous_claim' })
  })

  it('learns nothing for a merchant never booked: the field stays for the person', () => {
    expect(learnedExpenseAccount({ templateAccount: null, merchant: 'Ny butik', claims: [claim('Biltema', '5611', '2026-10-20T10:00:00Z')] })).toBeNull()
    expect(learnedExpenseAccount({ templateAccount: null, merchant: null, claims: [claim('', '5611', '2026-10-20T10:00:00Z')] })).toBeNull()
    expect(learnedExpenseAccount({ templateAccount: null, merchant: '   ', claims: [claim('', '5611', '2026-10-20T10:00:00Z')] })).toBeNull()
  })

  it('passes over an empty template account and a claim without an account', () => {
    expect(learnedExpenseAccount({ templateAccount: '  ', merchant: 'ICA', claims: [{ description: 'ICA', expense_account: null, created_at: null }] })).toBeNull()
  })

  it("passes over an account no longer in the company's chart, once the chart is known", () => {
    const chart = new Set(['5410', '7690'])
    expect(learnedExpenseAccount({ templateAccount: '5460', merchant: 'ICA', claims: [claim('ICA', '7690', '2026-10-01T10:00:00Z')], chart })).toEqual({
      account: '7690',
      basis: 'previous_claim',
    })
    expect(learnedExpenseAccount({ templateAccount: '5460', merchant: 'ICA', claims: [], chart: new Set() })).toEqual({ account: '5460', basis: 'counterparty' })
  })

  it('compares merchants without case, spacing or surrounding blanks', () => {
    expect(merchantKey('  Clas   OHLSON ')).toBe('clas ohlson')
    expect(merchantKey(null)).toBe('')
  })
})
