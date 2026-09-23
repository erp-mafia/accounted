import { describe, it, expect } from 'vitest'
import { normalizeBankTransactionCode, normalizedBankTransactionSchema } from '../index'

describe('normalizeBankTransactionCode', () => {
  it('flattens an Enable Banking object to code/sub_code when the ISO code is present', () => {
    expect(
      normalizeBankTransactionCode({ description: 'Card purchase', code: 'PMNT', sub_code: 'CCRD' }),
    ).toBe('PMNT/CCRD')
    expect(normalizeBankTransactionCode({ description: null, code: 'PMNT', sub_code: null })).toBe('PMNT')
    expect(normalizeBankTransactionCode({ code: ' PMNT ', sub_code: ' ' })).toBe('PMNT')
  })

  it('falls back to the description when the ASPSP left code null (the Swedish norm)', () => {
    expect(
      normalizeBankTransactionCode({ description: 'Kortköp/uttag', code: null, sub_code: null }),
    ).toBe('Kortköp/uttag')
    expect(normalizeBankTransactionCode({ description: 'Swish' })).toBe('Swish')
  })

  it('passes strings through trimmed and blanks as null', () => {
    expect(normalizeBankTransactionCode('PMNT-CCRD-POSD')).toBe('PMNT-CCRD-POSD')
    expect(normalizeBankTransactionCode('  XB ')).toBe('XB')
    expect(normalizeBankTransactionCode('   ')).toBeNull()
    expect(normalizeBankTransactionCode('')).toBeNull()
  })

  it('returns null for empty objects, arrays, numbers and nullish input', () => {
    expect(normalizeBankTransactionCode({ description: '', code: null, sub_code: null })).toBeNull()
    expect(normalizeBankTransactionCode({})).toBeNull()
    expect(normalizeBankTransactionCode(['PMNT'])).toBeNull()
    expect(normalizeBankTransactionCode(42)).toBeNull()
    expect(normalizeBankTransactionCode(null)).toBeNull()
    expect(normalizeBankTransactionCode(undefined)).toBeNull()
  })

  it('produces a value the wire schema accepts, which the raw object is not', () => {
    const raw = { description: 'Card purchase', code: null, sub_code: null }
    const base = {
      booking_date: '2026-09-03',
      amount: -250,
      currency: 'SEK',
      description: 'Card purchase',
      counterparty_name: null,
      counterparty_account: null,
      reference: null,
      merchant_category_code: null,
      proprietary_bank_transaction_code: null,
    }
    expect(normalizedBankTransactionSchema.safeParse({ ...base, bank_transaction_code: raw }).success).toBe(false)
    expect(
      normalizedBankTransactionSchema.safeParse({
        ...base,
        bank_transaction_code: normalizeBankTransactionCode(raw),
      }).success,
    ).toBe(true)
  })
})
