import { roundOre } from '@/lib/money'
import type { ParsedBankTransaction } from './types'

export interface BankFileCurrencyTotals {
  currency: string
  total_income: number
  total_expenses: number
}

/**
 * Per-currency income/expense totals for a parsed bank file.
 *
 * The parser-level stats (`stats.total_income` / `stats.total_expenses`) sum
 * every row regardless of currency, which is meaningless for multi-currency
 * exports (Wise emits per-row currencies, camt.053 reads Ccy per entry).
 * Sign convention matches the parsers: income positive, expenses negative.
 */
export function summarizeByCurrency(
  transactions: ParsedBankTransaction[],
): BankFileCurrencyTotals[] {
  const perCurrency = new Map<string, { total_income: number; total_expenses: number }>()
  for (const tx of transactions) {
    const currency = tx.currency || 'SEK'
    const row = perCurrency.get(currency) ?? { total_income: 0, total_expenses: 0 }
    if (tx.amount > 0) row.total_income += tx.amount
    else row.total_expenses += tx.amount
    perCurrency.set(currency, row)
  }
  return [...perCurrency.entries()]
    .map(([currency, totals]) => ({
      currency,
      total_income: roundOre(totals.total_income),
      total_expenses: roundOre(totals.total_expenses),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

/**
 * The currency most rows of a file are denominated in ('SEK' when none say).
 * One file is one physical account, so this is that account's currency: the
 * import binds every row of the batch to one account, and Wise and camt.053
 * files may still carry a few rows in another currency.
 */
export function dominantCurrency(transactions: Array<Pick<ParsedBankTransaction, 'currency'>>): string {
  const counts = new Map<string, number>()
  for (const tx of transactions) {
    const currency = (tx.currency || 'SEK').toUpperCase()
    counts.set(currency, (counts.get(currency) ?? 0) + 1)
  }
  let best = 'SEK'
  let bestCount = 0
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency
      bestCount = count
    }
  }
  return best
}
