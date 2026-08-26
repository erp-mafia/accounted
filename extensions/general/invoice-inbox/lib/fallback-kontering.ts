/**
 * Skeleton kontering for a matched transaction the engine has no proposal for.
 *
 * When suggest-booking comes back empty (unknown supplier, withheld
 * foreign-currency rule, engine failure) the manual-booking dialog used to
 * open with nothing at all, even though the matched bank row already tells us
 * the amount in kronor and the settlement account. This rebuilds what
 * BookDirectlyDialog's buildPrefillLines seeded before the dialog swap:
 * the transaction's SEK amount against the settlement account, with the
 * counter-account left blank for the user to pick. No VAT split: with a
 * matched transaction the old prefill skipped document VAT too, since the
 * document total and the bank movement are not guaranteed to agree.
 *
 * The SEK amount goes through resolveSekAmountOrNull: a foreign row with
 * neither a stored SEK value nor a rate has no honest kronor figure, and
 * prefilling the raw foreign number would relabel 100 EUR as 100 kr. In that
 * case we return no lines and the dialog opens blank, as it does today.
 */
import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'

export interface FallbackKonteringTx {
  amount: number
  amount_sek?: number | null
  currency?: string | null
  exchange_rate?: number | null
}

export interface FallbackKonteringLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

export function buildFallbackKonteringLines(
  tx: FallbackKonteringTx,
  settlementAccount: string,
): FallbackKonteringLine[] {
  const sek = resolveSekAmountOrNull(tx.amount, tx.amount_sek, tx.currency, tx.exchange_rate)
  if (sek == null) return []

  const total = roundOre(Math.abs(sek))
  if (total <= 0) return []

  const costLine: FallbackKonteringLine = {
    account_number: '',
    debit_amount: 0,
    credit_amount: 0,
    description: '',
  }
  const settlementLine: FallbackKonteringLine = {
    account_number: settlementAccount,
    debit_amount: 0,
    credit_amount: 0,
    description: '',
  }

  if (sek < 0) {
    // Money left the account: debit the (unknown) cost side, credit the bank.
    costLine.debit_amount = total
    settlementLine.credit_amount = total
    return [costLine, settlementLine]
  }
  // Money came in (refund, credit note payout): debit the bank instead.
  settlementLine.debit_amount = total
  costLine.credit_amount = total
  return [settlementLine, costLine]
}
