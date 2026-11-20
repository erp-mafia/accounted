/**
 * A payment provider's fee withheld from a customer's payment (crm#1364): the
 * customer paid the invoice in full through Stripe, PayPal, Klarna, SumUp or
 * the like, and the bank row is the provider's payout, net of its fee. The
 * customer-side mirror of the supplier bank fee (splitSupplierBankFee, which
 * absorbs a fee that makes the bank row LONGER than the debt).
 *
 * The invoice settles for exactly what it owed, in one verifikat: revenue and
 * moms on the full amount under kontantmetoden (the beskattningsunderlag is
 * what the customer paid, ML 8 kap. 2 §, not the payout), or 1510 credited the
 * full remaining under faktureringsmetoden; the bank leg books what arrived,
 * so 1930 follows the bank statement; and the fee is a cost on its own line,
 * never netted against revenue (ÅRL 2 kap. 4 §).
 *
 *   6570 Bankkostnader: the provider's charge for moving the money is a
 *        payment service exempt from VAT (ML 10 kap. 33 §): no input VAT, no
 *        reverse charge, nothing in the momsdeklaration. A provider's taxable
 *        services (subscriptions, Radar, Billing) are invoiced separately and
 *        never withheld from a payout this way.
 *
 * Never booked without the user naming the account, and only for a shortfall
 * of a krona or more (under that it is öresavrundning, ore-rounding.ts) and
 * strictly under PAYMENT_FEE_MAX_PERCENT of what the invoice owed: above that
 * the gap is a partial payment, not a fee.
 */
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { ORE_ROUNDING_SETTLEMENT_MAX, roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

/** The payment_fees role: BAS 6570 Bankkostnader in the SE pack. */
export const PAYMENT_FEE_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'payment_fees')

/** The accounts a payment provider's withheld fee may be booked on. */
export const PAYMENT_FEE_ACCOUNTS: readonly string[] = [PAYMENT_FEE_ACCOUNT]

/**
 * A fee is strictly under this share (percent) of what the invoice owed.
 * Card and wallet fees run from about 1,5 % to 5 % plus a fixed part, so a
 * tenth leaves room for an international card with currency conversion while
 * a customer who paid half is never written off as a fee.
 */
export const PAYMENT_FEE_MAX_PERCENT = 10

export function isPaymentFeeAccount(value: unknown): value is string {
  return typeof value === 'string' && PAYMENT_FEE_ACCOUNTS.includes(value)
}

/**
 * The shortfall of a SEK settlement: roundOre(owedSek - bankSek) when the bank
 * moved a krona or more LESS than was owed, else 0 (an exact or overpaid
 * settlement, or an öre residual that ore-rounding.ts books).
 */
export function paymentFeeShortfall(owedSek: number, bankSek: number): number {
  const shortfall = roundOre(roundOre(owedSek) - roundOre(bankSek))
  return shortfall >= ORE_ROUNDING_SETTLEMENT_MAX ? shortfall : 0
}

/** True when `account` may take `fee` of a settlement that owed `owedSek`. */
export function paymentFeeAllowed(account: string, fee: number, owedSek: number): boolean {
  if (!isPaymentFeeAccount(account) || !(fee > 0)) return false
  return fee * 100 < roundOre(owedSek) * PAYMENT_FEE_MAX_PERCENT
}

/** The debit line for a non-zero allowed fee on the chosen account. */
export function paymentFeeLine(fee: number, account: string): CreateJournalEntryLineInput {
  return {
    account_number: account,
    debit_amount: fee,
    credit_amount: 0,
    line_description: 'Avgift betaltjänst',
  }
}
