import type { BankBookingContext, Transaction } from '@/types'
import { equalOre } from '@/lib/money'
import { isKronorCurrency, resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'

/** Preserve the source snapshot, not a new lookup taken after the lines were built. */
export function bankBookingContext(
  transaction: Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'>,
  settlementAccount: string,
  targetCashAccountId?: string | null,
): BankBookingContext {
  return {
    transaction_id: transaction.id,
    cash_account_id: transaction.cash_account_id ?? null,
    settlement_account: settlementAccount,
    date: transaction.date,
    amount: transaction.amount,
    currency: transaction.currency ?? 'SEK',
    ...(targetCashAccountId ? { target_cash_account_id: targetCashAccountId } : {}),
  }
}

/**
 * Whether the lines book the transaction on its bank ledger in the bank's
 * direction: a withdrawal credits the ledger, a deposit debits it. The
 * guard_bank_booking_context trigger refuses the commit otherwise; checking
 * first lets the refusal name the account and the side, before any draft.
 * A zero amount has no direction and is left to the database.
 */
export function booksBankLineInBankDirection(
  lines: ReadonlyArray<{ account_number: string; debit_amount: number; credit_amount: number }>,
  settlementAccount: string,
  amount: number,
): boolean {
  if (amount === 0) return true
  return lines.some((line) =>
    line.account_number === settlementAccount &&
    (amount < 0 ? line.credit_amount > 0 : line.debit_amount > 0),
  )
}

/**
 * Whether the lines book a foreign-currency row that has no SEK value
 * (neither amount_sek nor exchange_rate: the rate lookup failed at ingest)
 * with its foreign amount on the bank ledger as if it were kronor. The
 * booking dialog prefills that figure when the row has no rate (accounted#58),
 * and journal lines are always SEK. Kronor typed from the bank statement are
 * a real booking, so only that signature is refused: a bank-ledger line equal
 * to the foreign amount. A row with a SEK value, or in SEK, never matches.
 */
export function booksForeignAmountAsKronor(
  lines: ReadonlyArray<{ account_number: string; debit_amount: number; credit_amount: number }>,
  settlementAccount: string,
  transaction: {
    amount: number
    currency?: string | null
    amount_sek?: number | null
    exchange_rate?: number | null
  },
): boolean {
  if (isKronorCurrency(transaction.currency)) return false
  const sek = resolveSekAmountOrNull(
    transaction.amount,
    transaction.amount_sek,
    transaction.currency,
    transaction.exchange_rate,
  )
  if (sek !== null) return false
  const foreign = Math.abs(transaction.amount)
  if (foreign === 0) return false
  return lines.some((line) =>
    line.account_number === settlementAccount &&
    (equalOre(line.debit_amount, foreign) || equalOre(line.credit_amount, foreign)),
  )
}
