import { describe, it, expect } from 'vitest'
import { summarizeByCurrency } from '../currency-summary'
import type { ParsedBankTransaction } from '../types'

function tx(overrides: Partial<ParsedBankTransaction>): ParsedBankTransaction {
  return {
    date: '2026-07-01',
    description: 'Test',
    amount: 0,
    currency: 'SEK',
    ...overrides,
  }
}

describe('summarizeByCurrency', () => {
  it('groups income and expenses per currency instead of mixing them', () => {
    const result = summarizeByCurrency([
      tx({ amount: 2500, currency: 'USD' }),
      tx({ amount: -100.5, currency: 'USD' }),
      tx({ amount: 1000, currency: 'SEK' }),
      tx({ amount: -250, currency: 'SEK' }),
      tx({ amount: -30, currency: 'EUR' }),
    ])

    expect(result).toEqual([
      { currency: 'EUR', total_income: 0, total_expenses: -30 },
      { currency: 'SEK', total_income: 1000, total_expenses: -250 },
      { currency: 'USD', total_income: 2500, total_expenses: -100.5 },
    ])
  })

  it('defaults a missing currency to SEK and rounds to ore', () => {
    const result = summarizeByCurrency([
      tx({ amount: 0.105, currency: '' }),
      tx({ amount: 0.105, currency: '' }),
    ])

    expect(result).toEqual([{ currency: 'SEK', total_income: 0.21, total_expenses: 0 }])
  })

  it('returns an empty list for no transactions', () => {
    expect(summarizeByCurrency([])).toEqual([])
  })
})
