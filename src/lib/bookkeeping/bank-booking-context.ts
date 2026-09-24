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
