import { describe, it, expect } from 'vitest'
import { deriveTransactionLabel } from '../transaction-label'

describe('deriveTransactionLabel', () => {
  it('prefers MCC over the ISO code (most specific signal)', () => {
    expect(deriveTransactionLabel({ mcc: '6011' })).toBe('Uttag')
    expect(deriveTransactionLabel({ mcc: 5411 })).toBe('Inköp dagligvaror')
    // MCC wins even when a (different-meaning) bank code is also present.
    expect(
      deriveTransactionLabel({ mcc: '6011', bankTransactionCode: 'PMNT/CCRD' }),
    ).toBe('Uttag')
  })

  it('maps ISO 20022 Domain/Family codes', () => {
    expect(deriveTransactionLabel({ bankTransactionCode: 'PMNT/RCDT' })).toBe('Inbetalning')
    expect(deriveTransactionLabel({ bankTransactionCode: 'PMNT/ICDT' })).toBe('Betalning')
    expect(deriveTransactionLabel({ bankTransactionCode: 'PMNT/CCRD' })).toBe('Kortköp')
    expect(deriveTransactionLabel({ bankTransactionCode: 'PMNT/RDDT' })).toBe('Autogiro')
  })

  it('parses dash- and dot-separated three-part codes (Domain-Family-SubFamily)', () => {
    expect(deriveTransactionLabel({ bankTransactionCode: 'PMNT-CCRD-POSD' })).toBe('Kortköp')
    expect(deriveTransactionLabel({ bankTransactionCode: 'pmnt.rcdt.esct' })).toBe('Inbetalning')
  })

  it('falls back to a keyword scan for proprietary code strings', () => {
    expect(
      deriveTransactionLabel({ proprietaryBankTransactionCode: 'INTEREST PAYMENT' }),
    ).toBe('Ränta')
    expect(
      deriveTransactionLabel({ proprietaryBankTransactionCode: 'ACCOUNT FEE' }),
    ).toBe('Avgift')
    expect(
      deriveTransactionLabel({ proprietaryBankTransactionCode: 'ATM WITHDRAWAL' }),
    ).toBe('Uttag')
  })

  it('uses the bare PMNT domain + direction as a last generic resort', () => {
    expect(deriveTransactionLabel({ bankTransactionCode: 'PMNT', isCredit: true })).toBe('Inbetalning')
    expect(deriveTransactionLabel({ bankTransactionCode: 'PMNT', isCredit: false })).toBe('Betalning')
  })

  it('returns null when nothing is recognized (caller falls through)', () => {
    expect(deriveTransactionLabel({})).toBeNull()
    expect(deriveTransactionLabel({ bankTransactionCode: 'ZZZZ/QQQQ' })).toBeNull()
    expect(deriveTransactionLabel({ mcc: '0000' })).toBeNull()
    // Bare unknown domain without isCredit cannot be classified.
    expect(deriveTransactionLabel({ bankTransactionCode: 'PMNT' })).toBeNull()
  })
})
