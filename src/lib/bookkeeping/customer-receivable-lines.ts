/**
 * Customer receivable rows on a split bank row: the customer side of the
 * supplier debt rows (lib/bookkeeping/supplier-debt-lines.ts). One incoming
 * bank row pays several customer invoices at once, some issued here and some
 * issued in the bookkeeping the company kept before. A Bankgirot deposit is
 * the usual case: the bank feed carries the deposit's total, and its payments
 * pay invoices from both systems. A company that moved in with SIE files has
 * those older invoices only as part of the 1510 balance the import brought
 * (SIE carries no reskontra), so they have no invoices row to allocate.
 *
 * The rest of the row is then a credit on that receivable: the fordran was
 * booked with the invoice in the old system, and so was its moms, so a
 * receivable row books no VAT. It is not a fee either, so it is not held to
 * "the fees are smaller than the invoices" and may be larger than the
 * invoices. The invoices less the fees plus the receivable rows equal the
 * bank row (payoutBankAmount, payout-fee-lines.ts).
 *
 * matchTransactionBatch hands customerReceivableLines() to
 * match_batch_allocate as p_debt_lines (the rows from before, on either side
 * of the bank row), and the preview
 * (lib/invoices/batch-allocation-preview.ts) projects the same rows. The RPC
 * checks every row again (supabase/migrations/20261124100000).
 */
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { roundOre, sumOre } from '@/lib/money'
import type { SupplierDebtLine } from '@/lib/bookkeeping/supplier-debt-lines'

/** The account a receivable row starts on: the accounts_receivable role's account (1510 Kundfordringar). */
export const CUSTOMER_RECEIVABLE_DEFAULT_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable')

/** A receivable row's text on the verifikat is cut to this length. */
export const CUSTOMER_RECEIVABLE_DESCRIPTION_MAX = 100

/** The line text when the request gives none (the RPC's own default). */
export const CUSTOMER_RECEIVABLE_DEFAULT_DESCRIPTION = 'Kundfordran från tidigare bokföring'

/** One receivable row as a request states it. */
export interface CustomerReceivable {
  account: string
  amount: number
  description?: string | null
}

/** One receivable row as match_batch_allocate takes it (p_debt_lines) and books it: the debt row's shape. */
export type CustomerReceivableLine = SupplierDebtLine

/**
 * The account group a receivable row books in: the group of the
 * accounts_receivable role's account (151x in the SE pack: 1510
 * Kundfordringar and its kin).
 */
const CUSTOMER_RECEIVABLE_GROUP = CUSTOMER_RECEIVABLE_DEFAULT_ACCOUNT.slice(0, 3)

/** A four-digit account in the customer receivable group. Whether it is active is the chart's answer. */
export function isCustomerReceivableAccount(account: string): boolean {
  return typeof account === 'string' && ACCOUNT_NUMBER_RE.test(account) && account.startsWith(CUSTOMER_RECEIVABLE_GROUP)
}

/** The rows as the verifikat carries them: öre-rounded amounts, the default text where none is given. */
export function customerReceivableLines(
  receivables: readonly CustomerReceivable[] | null | undefined,
): CustomerReceivableLine[] {
  return (receivables ?? []).map((receivable) => ({
    account: receivable.account,
    amount: roundOre(receivable.amount),
    description: (receivable.description?.trim() || CUSTOMER_RECEIVABLE_DEFAULT_DESCRIPTION).slice(
      0,
      CUSTOMER_RECEIVABLE_DESCRIPTION_MAX,
    ),
  }))
}

/** The receivable rows together, rounded once. */
export function customerReceivableTotal(receivables: readonly CustomerReceivable[] | null | undefined): number {
  return sumOre((receivables ?? []).map((receivable) => roundOre(receivable.amount)))
}
