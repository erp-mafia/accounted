import { describe, expect, it } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import type { MappingResult } from '@/types'
import { applyVatAmountOverride } from '../vat-amount-override'

const expenseResult = (): MappingResult => ({
  rule: null,
  debit_account: '5020',
  credit_account: '1930',
  risk_level: 'LOW',
  confidence: 1,
  requires_review: false,
  default_private: false,
  description: 'El & Uppvärmning',
  vat_lines: [{ account_number: '2641', debit_amount: 246.19, credit_amount: 0, description: 'Ingående moms 25%' }],
})

describe('applyVatAmountOverride', () => {
  it('replaces the input VAT line with the document\'s moms', () => {
    const tx = makeTransaction({ amount: -1230.97, currency: 'SEK', amount_sek: null, exchange_rate: null })
    const out = applyVatAmountOverride(expenseResult(), tx, 'standard_25', 200)
    expect(out.vat_lines).toEqual([
      { account_number: '2641', debit_amount: 200, credit_amount: 0, description: 'Ingående moms (enligt underlag)' },
    ])
  })

  it('scales a foreign-currency moms by the gross\'s own SEK ratio', () => {
    const tx = makeTransaction({ amount: -100, currency: 'EUR', amount_sek: -1100, exchange_rate: 11 })
    const out = applyVatAmountOverride(expenseResult(), tx, 'standard_25', 20)
    expect(out.vat_lines[0].debit_amount).toBe(220)
  })

  it('refuses treatments without a rate, non-positive amounts and impossible amounts', () => {
    const tx = makeTransaction({ amount: -1230.97, currency: 'SEK', amount_sek: null, exchange_rate: null })
    expect(() => applyVatAmountOverride(expenseResult(), tx, 'reverse_charge', 10)).toThrow(/reverse_charge/)
    expect(() => applyVatAmountOverride(expenseResult(), tx, 'standard_25', 0)).toThrow(/positive/)
    expect(() => applyVatAmountOverride(expenseResult(), tx, 'standard_25', 400)).toThrow(/exceeds/)
  })

  it('refuses when the booking has no VAT line to replace', () => {
    const tx = makeTransaction({ amount: -100, currency: 'SEK', amount_sek: null, exchange_rate: null })
    expect(() => applyVatAmountOverride({ ...expenseResult(), vat_lines: [] }, tx, 'standard_25', 10)).toThrow(/none/)
  })
})
