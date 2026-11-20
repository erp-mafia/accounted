import type { BankBookingContext, CreateJournalEntryLineInput, Transaction } from '@/types'
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

/**
 * The lines with each foreign bank row's own figure on the line that books
 * it: `currency` + `amount_in_currency` (the magnitude; readers take the
 * direction from the debit or credit side, see ledgerLineAmountIn).
 *
 * Journal lines are kronor. On a cash account kept in another currency the
 * only figure reconciliation can read in that currency is amount_in_currency
 * on the bank line; without it the line is unconvertible and the account
 * answers gl_lines_missing_currency_amount (crm#1590). Every door that books
 * a bank row declares the row and its ledger account in bank_booking_context,
 * so the engine stamps the figure here, once, instead of each line builder
 * remembering to: only the categorize builder did, and every invoice and
 * supplier-invoice match, cash-method payment and private booking of a
 * foreign row posted the bank line without it.
 *
 * The figure is the bank's, whatever kronor the line carries. Stamped only
 * where the line is unambiguous: one foreign row on the account and side,
 * exactly one line there, and that line not already carrying a foreign
 * label or figure (a builder that stamps its own, as the categorize builder
 * does, is left as it is). SEK rows and SEK-only companies are untouched.
 */
export function withBankLegCurrency(
  lines: CreateJournalEntryLineInput[],
  contexts: readonly BankBookingContext[] | undefined,
): CreateJournalEntryLineInput[] {
  if (!contexts || contexts.length === 0) return lines
  const sideOf = (amount: number) => (amount < 0 ? 'credit' : 'debit')
  const slot = (c: BankBookingContext) => `${c.settlement_account}|${sideOf(c.amount)}`
  const rowsPerSlot = new Map<string, number>()
  for (const c of contexts) rowsPerSlot.set(slot(c), (rowsPerSlot.get(slot(c)) ?? 0) + 1)

  let out = lines
  for (const c of contexts) {
    if (isKronorCurrency(c.currency) || !Number.isFinite(c.amount) || c.amount === 0) continue
    if (rowsPerSlot.get(slot(c)) !== 1) continue
    const side = sideOf(c.amount)
    const onSlot = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) =>
        line.account_number === c.settlement_account &&
        (side === 'credit' ? line.credit_amount > 0 : line.debit_amount > 0),
      )
    if (onSlot.length !== 1) continue
    const { line, index } = onSlot[0]
    if (!isKronorCurrency(line.currency) || line.amount_in_currency != null) continue
    if (out === lines) out = [...lines]
    out[index] = { ...line, currency: c.currency, amount_in_currency: Math.abs(c.amount) }
  }
  return out
}
