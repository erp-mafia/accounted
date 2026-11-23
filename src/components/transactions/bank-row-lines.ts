import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import { resolveSekAmount, buildCurrencyMetadata, isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { roundOre, formatAmountInput } from '@/lib/money'
import type { Transaction } from '@/types'

/**
 * The two lines a bank row opens with when it is booked by hand: the bank
 * leg on the side the money moved (credit for money out, debit for money
 * in), in SEK with the foreign amount and rate on it, and an empty counter
 * line for the same amount, prefilled with an account the person already
 * picked. `bankAccount` is the ledger account the row's cash account resolves
 * to (resolveAccount), never assumed. Shared by the booking dialog and the
 * booking screen so the two open the same verifikat.
 */
export function bankRowInitialLines(
  transaction: Pick<Transaction, 'amount' | 'amount_sek' | 'currency' | 'exchange_rate'>,
  bankLineDescription: string,
  bankAccount: string,
  counterAccount?: string | null,
): FormLine[] {
  const sekAmount = roundOre(Math.abs(resolveSekAmount(
    transaction.amount,
    transaction.amount_sek,
    transaction.currency,
    transaction.exchange_rate
  )))
  const amountStr = formatAmountInput(sekAmount, '.')
  const isExpense = transaction.amount < 0

  const isForeign = !isKronorCurrency(transaction.currency)
  const currencyMeta = isForeign
    ? buildCurrencyMetadata(
        transaction.currency,
        Math.abs(transaction.amount),
        transaction.exchange_rate
      )
    : {}

  const bankLine: FormLine = {
    account_number: bankAccount,
    debit_amount: isExpense ? '' : amountStr,
    credit_amount: isExpense ? amountStr : '',
    line_description: bankLineDescription,
    ...currencyMeta,
  }

  const counterLine: FormLine = {
    account_number: counterAccount ?? '',
    debit_amount: isExpense ? amountStr : '',
    credit_amount: isExpense ? '' : amountStr,
    line_description: '',
  }

  return [bankLine, counterLine]
}
