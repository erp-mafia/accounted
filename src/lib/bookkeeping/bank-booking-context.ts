import type { BankBookingContext, Transaction } from '@/types'

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
