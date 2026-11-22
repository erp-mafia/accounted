/**
 * Supplier debt rows on a split bank row (crm#1954): one outgoing bank row
 * pays several supplier invoices at once, some registered in the
 * leverantörsreskontra here and some registered in the bookkeeping the
 * company kept before. A company that moved in with SIE files has those
 * older invoices only as part of the 2440 balance the import brought (SIE
 * carries no reskontra), so they have no supplier_invoices row to allocate.
 *
 * The rest of the row is then a debit on that supplier debt, not a bank cost:
 * the skuld was booked with the invoice in the old system, and so was its
 * moms, so a debt row books no VAT. It is not a fee either, so it is not held
 * to "the fees are smaller than the invoices" and may be larger than the
 * invoices. The invoices plus the fees plus the debt rows equal the bank row
 * (payoutBankAmount, payout-fee-lines.ts).
 *
 * One builder for both sides of the bank row: matchTransactionBatch hands
 * supplierDebtLines() to match_batch_allocate as p_debt_lines, and the
 * preview (lib/invoices/batch-allocation-preview.ts) projects the same rows.
 * The RPC checks every row again (supabase/migrations/20261120150000).
 */
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { roundOre, sumOre } from '@/lib/money'

/** The account a debt row starts on: the accounts_payable role's account (2440 Leverantörsskulder). */
export const SUPPLIER_DEBT_DEFAULT_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'accounts_payable')

/** A debt row's text on the verifikat is cut to this length. */
export const SUPPLIER_DEBT_DESCRIPTION_MAX = 100

/** The line text when the request gives none (the RPC's own default). */
export const SUPPLIER_DEBT_DEFAULT_DESCRIPTION = 'Leverantörsskuld från tidigare bokföring'

/** One debt row as a request states it. */
export interface SupplierDebt {
  account: string
  amount: number
  description?: string | null
}

/** One debt row as match_batch_allocate takes it (p_debt_lines) and books it. */
export interface SupplierDebtLine {
  account: string
  amount: number
  description: string
}

/**
 * The account group a debt row books in: the group of the accounts_payable
 * role's account (244x in the SE pack: 2440 Leverantörsskulder, 2448 Ej
 * reskontraförda leverantörsskulder and their kin).
 */
const SUPPLIER_DEBT_GROUP = SUPPLIER_DEBT_DEFAULT_ACCOUNT.slice(0, 3)

/** A four-digit account in the supplier debt group. Whether it is active is the chart's answer. */
export function isSupplierDebtAccount(account: string): boolean {
  return typeof account === 'string' && ACCOUNT_NUMBER_RE.test(account) && account.startsWith(SUPPLIER_DEBT_GROUP)
}

/** The rows as the verifikat carries them: öre-rounded amounts, the default text where none is given. */
export function supplierDebtLines(debts: readonly SupplierDebt[] | null | undefined): SupplierDebtLine[] {
  return (debts ?? []).map((debt) => ({
    account: debt.account,
    amount: roundOre(debt.amount),
    description: (debt.description?.trim() || SUPPLIER_DEBT_DEFAULT_DESCRIPTION).slice(0, SUPPLIER_DEBT_DESCRIPTION_MAX),
  }))
}

/** The debt rows together, rounded once. */
export function supplierDebtTotal(debts: readonly SupplierDebt[] | null | undefined): number {
  return sumOre((debts ?? []).map((debt) => roundOre(debt.amount)))
}
