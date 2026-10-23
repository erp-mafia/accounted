import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { fetchSupplierLedgerInvoices } from './supplier-ledger-invoices'
import { closingBalanceOf } from './trial-balance'

export interface ReconciliationResult {
  supplier_ledger_total: number
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
 * Compare sum of open supplier invoices against account 2440 balance.
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

  // remaining_amount is stored in invoice currency; account 2440 is in SEK
  // (booked at invoice-date rate), so convert each row before summing.
  // The open invoices are the live leverantörsreskontra's population (one
  // read, in id order: supplier-ledger-invoices.ts), and the 2440 balance is
  // read beside it.
  const [invoices, debitMinusCredit] = await Promise.all([
    fetchSupplierLedgerInvoices(supabase, companyId),
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

  let unconvertedFxCount = 0
  const supplierLedgerTotal = (invoices || [])
    .reduce((sum, inv) => {
      const isFx = inv.currency && inv.currency !== 'SEK'
      const hasRate = inv.exchange_rate != null && Number(inv.exchange_rate) > 0
      // Skip unconvertible FX rows from the sum: adding raw foreign amounts
      // to a SEK total is arithmetically unsound. Counted instead.
      if (isFx && !hasRate) {
        unconvertedFxCount += 1
        return sum
      }
      const sek = resolveSekAmount(
        Number(inv.remaining_amount) || 0,
        null,
        inv.currency,
        inv.exchange_rate
      )
      return Math.round((sum + sek) * 100) / 100
    }, 0)

  const account2440Balance = 0 - debitMinusCredit

  const difference = Math.round((supplierLedgerTotal - account2440Balance) * 100) / 100

  return {
    supplier_ledger_total: Math.round(supplierLedgerTotal * 100) / 100,
    account_2440_balance: Math.round(account2440Balance * 100) / 100,
    difference,
    // BFL 5 kap requires the reconciliation to cover all affärshändelser. If
    // any row was excluded for a missing exchange rate, the calculation is
    // incomplete by construction and we cannot honestly stamp the period
    // Avstämd: the user must fix the underlying data first.
    is_reconciled: Math.abs(difference) < 0.01 && unconvertedFxCount === 0,
    unconverted_fx_count: unconvertedFxCount,
  }
}
