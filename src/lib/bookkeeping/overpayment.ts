/**
 * A customer overpayment on a bank-matched SEK invoice: the part of the bank
 * receipt above what the invoice still owed, by a krona or more. Anything
 * under a krona is öresavrundning and settles on 3740 automatically
 * (ore-rounding.ts); this is the band above it, which is never booked
 * without the user naming the account (crm#253).
 *
 *   2420 Förskott från kunder: the customer's money, a liability to refund or
 *        to offset against a later invoice. Any amount.
 *   3740 Öres- och kronutjämning: the customer rounded the payment up. FAR
 *        Redovisa rätt (Fakturaförsäljning): when the customer has rounded to
 *        whole kronor the difference may be booked separately on 3740. Only
 *        under OVERPAYMENT_ROUNDING_MAX, so a real overpayment is never
 *        written off as rounding. No VAT, like the öre line.
 *
 * The invoice settles for exactly what it owed; the bank leg books what
 * arrived and the chosen account takes the excess, so 1930 follows the bank
 * statement and 1510 (or the kontantmetoden revenue) never moves.
 */
import { ORE_ROUNDING_ACCOUNT, ORE_ROUNDING_SETTLEMENT_MAX, roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

/** BAS 2420 Förskott från kunder. */
export const CUSTOMER_ADVANCE_ACCOUNT = '2420'

/** The accounts a customer overpayment may be booked on. */
export const OVERPAYMENT_ACCOUNTS: readonly string[] = [CUSTOMER_ADVANCE_ACCOUNT, ORE_ROUNDING_ACCOUNT]

/**
 * 3740 takes an overpayment strictly under this (SEK): a customer rounding
 * up to the next ten kronor stays inside it, a real overpayment does not.
 * 2420 has no cap.
 */
export const OVERPAYMENT_ROUNDING_MAX = 10

export function isOverpaymentAccount(value: unknown): value is string {
  return typeof value === 'string' && OVERPAYMENT_ACCOUNTS.includes(value)
}

/**
 * The overpayment of a SEK settlement: roundOre(bankSek - owedSek) when the
 * bank moved a krona or more above what was owed, else 0 (an exact or short
 * settlement, or an öre residual that ore-rounding.ts books).
 */
export function overpaymentExcess(owedSek: number, bankSek: number): number {
  const excess = roundOre(roundOre(bankSek) - roundOre(owedSek))
  return excess >= ORE_ROUNDING_SETTLEMENT_MAX ? excess : 0
}

/** True when `account` may take `excess` (3740 only under the cap). */
export function overpaymentAllowed(account: string, excess: number): boolean {
  if (!isOverpaymentAccount(account)) return false
  return account !== ORE_ROUNDING_ACCOUNT || excess < OVERPAYMENT_ROUNDING_MAX
}

/** The credit line for a non-zero `overpaymentExcess` on the chosen account. */
export function overpaymentLine(excess: number, account: string): CreateJournalEntryLineInput {
  return {
    account_number: account,
    debit_amount: 0,
    credit_amount: excess,
    line_description: account === ORE_ROUNDING_ACCOUNT ? 'Kronutjämning' : 'Överbetalning, förskott från kund',
  }
}
