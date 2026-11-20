import type { SupabaseClient } from '@supabase/supabase-js'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { reskontraBalanceDate } from './reskontra-balance-date'
import { generateSupplierLedger } from './supplier-ledger'
import { closingBalanceOf } from './trial-balance'

export interface ReconciliationResult {
  /** The leverantörsreskontra's total on the balance date: the same figure as generateSupplierLedger. */
  supplier_ledger_total: number
  /** The day the reskontra is read as of: a past year's last day, null while the year runs (today). */
  as_of_date: string | null
  /** Closing balance (UB, ingående balans included) of 2440, credit minus debit, as the balance sheet shows it. */
  account_2440_balance: number
  difference: number
  is_reconciled: boolean
  /**
   * Number of foreign-currency invoices that lacked an exchange_rate, so their
   * remaining_amount could not be converted to SEK. When > 0 the difference
   * field may be misleading: any reported gap could be missing-data rather
   * than a true reconciliation break.
   */
  unconverted_fx_count: number
}

/**
 * Compare the leverantörsreskontra with account 2440 at the end of a fiscal
 * year: generateSupplierLedger as of the year's last day against the UB. While
 * the year runs that is the live register (the ledger's rule for today or a
 * date ahead); a past year reads the invoices open on its balansdag, not the
 * ones open today.
 *
 * Conversion uses each invoice's stored exchange_rate (the invoice-date rate),
 * which matches what was originally posted to 2440. This means the report will
 * diverge from the GL once partial payments settle at a different rate (the
 * delta is correctly booked as valutakursvinst/-förlust to 3960/7960 per
 * ML 8 kap 21-23 §). A subledger-derived total would reconcile through that
 * difference; deferred to a follow-up.
 */
export async function generateReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string
): Promise<ReconciliationResult> {
  const asOfDate = await reskontraBalanceDate(supabase, companyId, periodId)

  const [ledger, debitMinusCredit] = await Promise.all([
    generateSupplierLedger(supabase, companyId, asOfDate ?? undefined, { strict: true }),
    // The booked 2440 balance, read as the balance sheet reads it
    // (closingBalanceOf: the trial balance's UB, ingående balans included,
    // posted and reversed entries both counted so a corrected registration
    // nets against its storno). The open invoices are every open invoice of
    // the register, whatever year it was booked in, so the ledger side must
    // carry the opening balance too: summing only this fiscal year's
    // verifikat left out an IB carried from earlier years' verifikat and
    // showed that IB as a false difference (crm#1296). 2440 is a liability,
    // credit-normal: balance = credits - debits (0 minus, so an empty account
    // reads 0, not -0).
    closingBalanceOf(supabase, companyId, periodId, [
      resolveAccountRole(PINNED_JURISDICTION, 'accounts_payable'),
    ]),
  ])

  const account2440Balance = 0 - debitMinusCredit

  const difference = Math.round((ledger.total_outstanding - account2440Balance) * 100) / 100

  return {
    supplier_ledger_total: ledger.total_outstanding,
    as_of_date: asOfDate,
    account_2440_balance: Math.round(account2440Balance * 100) / 100,
    difference,
    // BFL 5 kap requires the reconciliation to cover all affärshändelser. If
    // any row was excluded for a missing exchange rate, the calculation is
    // incomplete by construction and we cannot honestly stamp the period
    // Avstämd: the user must fix the underlying data first.
    is_reconciled: Math.abs(difference) < 0.01 && ledger.unconverted_fx_count === 0,
    unconverted_fx_count: ledger.unconverted_fx_count,
  }
}
