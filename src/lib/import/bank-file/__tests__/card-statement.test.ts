import { describe, it, expect } from 'vitest'
import {
  cardStatementPrintsPurchasesAsPlus,
  cardStatementStats,
  flipCardStatementSigns,
} from '../card-statement'
import type { BankFileParseResult, ParsedBankTransaction } from '../types'

const row = (description: string, amount: number, extra: Partial<ParsedBankTransaction> = {}): ParsedBankTransaction => ({
  date: '2026-09-20',
  description,
  amount,
  currency: 'SEK',
  ...extra,
})

// As an issuer prints it: purchases plus, the payment minus.
const printed = [
  row('Molnkontoret AB', 349),
  row('Flygbolaget Norr', 2450.5),
  row('Årsavgift', 95),
  row('Inbetalning, tack', -12345),
  row('Kreditering Molnkontoret AB', -349),
]

function parseResult(transactions: ParsedBankTransaction[]): BankFileParseResult {
  return {
    format: 'generic_csv',
    format_name: 'CSV',
    transactions,
    date_from: '2026-09-16',
    date_to: '2026-10-15',
    issues: [],
    stats: { total_rows: transactions.length, parsed_rows: transactions.length, skipped_rows: 0, total_income: 0, total_expenses: 0 },
  }
}

describe('cardStatementPrintsPurchasesAsPlus', () => {
  it('detects an issuer export that prints purchases as plus', () => {
    expect(cardStatementPrintsPurchasesAsPlus(printed)).toBe(true)
  })

  it('leaves a file already in the company perspective alone', () => {
    expect(cardStatementPrintsPurchasesAsPlus(printed.map((r) => ({ ...r, amount: -r.amount })))).toBe(false)
  })

  it('decides a payments-only file by the payment sign', () => {
    expect(cardStatementPrintsPurchasesAsPlus([row('Inbetalning bankgiro', -5000)])).toBe(true)
    expect(cardStatementPrintsPurchasesAsPlus([row('Inbetalning bankgiro', 5000)])).toBe(false)
  })
})

describe('flipCardStatementSigns', () => {
  it('flips every amount and running balance and recomputes the totals', () => {
    const flipped = flipCardStatementSigns(parseResult([...printed, row('Kaffe', 45, { balance: 1200 })]))
    expect(flipped.transactions.map((r) => r.amount)).toEqual([-349, -2450.5, -95, 12345, 349, -45])
    expect(flipped.transactions[5].balance).toBe(-1200)
    expect(flipped.stats.total_income).toBe(12694)
    expect(flipped.stats.total_expenses).toBe(-2939.5)
  })

  it('never produces a negative zero', () => {
    const flipped = flipCardStatementSigns(parseResult([row('Noll', 0)]))
    expect(Object.is(flipped.transactions[0].amount, -0)).toBe(false)
  })

  it('round-trips', () => {
    const once = flipCardStatementSigns(parseResult(printed))
    expect(flipCardStatementSigns(once).transactions.map((r) => r.amount)).toEqual(printed.map((r) => r.amount))
  })
})

describe('cardStatementStats', () => {
  it('groups purchases, fees, payments and refunds in the stored sign', () => {
    const stored = flipCardStatementSigns(parseResult(printed)).transactions
    expect(cardStatementStats(stored)).toEqual({
      purchases: { count: 2, total: -2799.5 },
      fees: { count: 1, total: -95 },
      payments: { count: 1, total: 12345 },
      refunds: { count: 1, total: 349 },
      currencies: ['SEK'],
    })
  })

  it('sums to the öre', () => {
    const stats = cardStatementStats([row('A', -0.1), row('B', -0.2)])
    expect(stats.purchases.total).toBe(-0.3)
  })
})
