/**
 * Fee rows on a split bank row ("Dela betalning", issue #131 step 1): one
 * bank row settles N invoices and the difference is a fee the payment
 * service took.
 *
 *   customer side  a payout net of the provider's fee (Stripe, Klarna, card
 *                  acquirers): the invoices less the fees equal the bank row.
 *   supplier side  a payment the bank charged a fee on top of: the invoices
 *                  plus the fees equal the bank row.
 *
 * Every invoice settles for what it owed, the bank leg books what the bank
 * moved, and each fee is a cost on its own debit line, never netted against
 * revenue (ÅRL 2 kap. 4 §). A payment service's charge for moving money is
 * exempt (ML 10 kap. 33 §): no VAT line, nothing in the momsdeklaration. So
 * a fee books only on BAS class 6, where card, bank and factoring fees live
 * (6040, 6064, 6570) and which no momsdeklaration ruta reads; the class 4
 * purchase accounts that carry a reverse-charge base (4415 to 4547) are out
 * of reach. A platform's commission is a taxable service and is not a fee
 * row (issue #131 step 2).
 *
 * One builder for both sides of the bank row: matchTransactionBatch hands
 * payoutFeeLines() to match_batch_allocate as p_fee_lines, and the preview
 * (lib/invoices/batch-allocation-preview.ts) projects the same rows. The RPC
 * checks every row again (supabase/migrations/20261028231700).
 */
import { PAYMENT_FEE_ACCOUNT } from '@/lib/bookkeeping/payment-fee'
import { roundOre, sumOre } from '@/lib/money'

/** At most this many fee rows on one bank row (MatchBatchSchema, match_batch_allocate). */
export const MAX_PAYOUT_FEES = 5

/** A fee row's text on the verifikat is cut to this length. */
export const PAYOUT_FEE_DESCRIPTION_MAX = 100

/** The line text when the request gives none (as the single-invoice fee line, payment-fee.ts). */
export const PAYOUT_FEE_DEFAULT_DESCRIPTION = 'Avgift betaltjänst'

/** One fee row as a request states it. */
export interface PayoutFee {
  account: string
  amount: number
  description?: string | null
}

/** One fee row as match_batch_allocate takes it (p_fee_lines) and books it. */
export interface PayoutFeeLine {
  account: string
  amount: number
  description: string
}

/**
 * The account class a fee row books in: the class of the payment_fees role's
 * account (6570 Bankkostnader in the SE pack: BAS class 6, övriga externa
 * kostnader).
 */
const PAYOUT_FEE_CLASS = PAYMENT_FEE_ACCOUNT.slice(0, 1)

/** A four-digit account in the fee class. Whether it is active is the chart's answer. */
export function isPayoutFeeAccount(account: string): boolean {
  return typeof account === 'string' && /^\d{4}$/.test(account) && account[0] === PAYOUT_FEE_CLASS
}

/** The rows as the verifikat carries them: öre-rounded amounts, the default text where none is given. */
export function payoutFeeLines(fees: readonly PayoutFee[] | null | undefined): PayoutFeeLine[] {
  return (fees ?? []).map((fee) => ({
    account: fee.account,
    amount: roundOre(fee.amount),
    description: (fee.description?.trim() || PAYOUT_FEE_DEFAULT_DESCRIPTION).slice(0, PAYOUT_FEE_DESCRIPTION_MAX),
  }))
}

/** The fees together, rounded once. */
export function payoutFeeTotal(fees: readonly PayoutFee[] | null | undefined): number {
  return sumOre((fees ?? []).map((fee) => roundOre(fee.amount)))
}

/**
 * What the bank row must carry for invoices settled for `allocatedTotal`
 * with `feeTotal` in fees: the customer's provider withheld the fees, the
 * supplier's bank added them. The row also carries `debtTotal`, the rows
 * from before that it pays beside the invoices: the supplier debt
 * (lib/bookkeeping/supplier-debt-lines.ts) or the customer receivable
 * (lib/bookkeeping/customer-receivable-lines.ts).
 */
export function payoutBankAmount(
  kind: 'customer_invoice' | 'supplier_invoice',
  allocatedTotal: number,
  feeTotal: number,
  debtTotal = 0,
): number {
  return kind === 'customer_invoice'
    ? roundOre(allocatedTotal - feeTotal + debtTotal)
    : roundOre(allocatedTotal + feeTotal + debtTotal)
}

/**
 * A fee is smaller than the invoices it settles: past that the row is not a
 * payment of these invoices at all. Replaces, for a split row, the single
 * invoice's 10 % cap (PAYMENT_FEE_MAX_PERCENT): an OTA's commission runs 15
 * to 18 %.
 */
export function payoutFeesWithinInvoices(allocatedTotal: number, feeTotal: number): boolean {
  return roundOre(feeTotal) < roundOre(allocatedTotal)
}
