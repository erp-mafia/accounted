/**
 * A card statement (kortfaktura) imported to a company card: the sign and
 * the summary the import wizard shows before anything lands.
 *
 * Every cash account stores amounts from the company's side: money out is
 * negative. A card purchase is money out (the debt grows), the monthly
 * payment from the bank is money in (the debt shrinks). Issuers print it the
 * other way round: a purchase as +349,00 and the payment as -12 345,00. So a
 * statement is flipped once, in the wizard, before the preview, and what the
 * preview shows is exactly what the execute route stores (and what
 * generateExternalId hashes).
 *
 * Pure: the wizard (client) and the tests share it.
 */
import { roundOre } from '@/lib/money'
import type { BankFileParseResult, ParsedBankTransaction } from './types'

/** The issuer's own payment row: "Inbetalning, tack", "Betalning bankgiro", autogiro. */
const PAYMENT_TEXT = /\b(inbetalning|inbet|betalning|betald|autogiro|tack|payment|thank you)\b/i

/** Fees and interest the issuer charges on the statement itself. */
const FEE_TEXT = /(avgift|årsavgift|valutapåslag|påslag|ränta|dröjsmål|fee|interest)/i

function isPaymentText(row: Pick<ParsedBankTransaction, 'description' | 'counterparty'>): boolean {
  return PAYMENT_TEXT.test(`${row.description} ${row.counterparty ?? ''}`)
}

function isFeeText(row: Pick<ParsedBankTransaction, 'description' | 'counterparty'>): boolean {
  return FEE_TEXT.test(`${row.description} ${row.counterparty ?? ''}`)
}

/**
 * Whether the file prints purchases as plus (the issuer's side), so the
 * wizard flips it. Decided on the rows that are not the payment: most of
 * them positive means purchases are printed as plus. A statement of payments
 * only is decided by them: a payment printed as minus is the issuer's side.
 * The switch in the preview overrides it either way.
 */
export function cardStatementPrintsPurchasesAsPlus(rows: ReadonlyArray<ParsedBankTransaction>): boolean {
  const others = rows.filter((row) => row.amount !== 0 && !isPaymentText(row))
  if (others.length > 0) {
    const positive = others.filter((row) => row.amount > 0).length
    return positive > others.length - positive
  }
  const payments = rows.filter((row) => row.amount !== 0)
  const negative = payments.filter((row) => row.amount < 0).length
  return negative > payments.length - negative
}

function negate(value: number): number {
  // -0 would print as "-0,00 kr".
  return value === 0 ? 0 : -value
}

/** The statement with every amount (and running balance) from the other side. */
export function flipCardStatementSigns(result: BankFileParseResult): BankFileParseResult {
  const transactions = result.transactions.map((row) => ({
    ...row,
    amount: negate(row.amount),
    ...(row.balance != null ? { balance: negate(row.balance) } : {}),
  }))
  const income = roundOre(transactions.filter((row) => row.amount > 0).reduce((sum, row) => sum + row.amount, 0))
  const expenses = roundOre(transactions.filter((row) => row.amount < 0).reduce((sum, row) => sum + row.amount, 0))
  return {
    ...result,
    transactions,
    stats: { ...result.stats, total_income: income, total_expenses: expenses },
  }
}

export interface CardStatementGroup {
  count: number
  /** Stored sign: purchases and fees negative, payments and refunds positive. */
  total: number
}

export interface CardStatementStats {
  purchases: CardStatementGroup
  fees: CardStatementGroup
  payments: CardStatementGroup
  refunds: CardStatementGroup
  /** The distinct currencies of the rows; the totals are only meaningful with one. */
  currencies: string[]
}

/**
 * What the statement holds, in the stored sign: purchases (money out that is
 * not a fee), the issuer's fees and interest, the payments from the bank and
 * the refunds (money in that is not a payment).
 */
export function cardStatementStats(rows: ReadonlyArray<ParsedBankTransaction>): CardStatementStats {
  const empty = (): CardStatementGroup => ({ count: 0, total: 0 })
  const stats = { purchases: empty(), fees: empty(), payments: empty(), refunds: empty() }
  const add = (group: CardStatementGroup, amount: number) => {
    group.count += 1
    group.total = roundOre(group.total + amount)
  }
  for (const row of rows) {
    if (row.amount < 0) add(isFeeText(row) ? stats.fees : stats.purchases, row.amount)
    else if (row.amount > 0) add(isPaymentText(row) ? stats.payments : stats.refunds, row.amount)
  }
  const currencies = [...new Set(rows.map((row) => (row.currency || 'SEK').toUpperCase()))]
  return { ...stats, currencies }
}
