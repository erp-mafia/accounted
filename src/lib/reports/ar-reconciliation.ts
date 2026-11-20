import type { SupabaseClient } from '@supabase/supabase-js'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { hasPreRegisterArInPeriod } from '@/lib/reports/invoice-register-coverage'
import { generateARLedger } from './ar-ledger'
import { reskontraBalanceDate } from './reskontra-balance-date'
import { closingBalanceOf } from './trial-balance'

export interface ARReconciliationResult {
  /** The kundreskontra's total on the balance date: the same figure as generateARLedger. */
  ar_ledger_total: number
  /** The day the reskontra is read as of: a past year's last day, null while the year runs (today). */
  as_of_date: string | null
  /**
   * Closing balance (UB, ingående balans included) of accounts 1510
   * (Kundfordringar) and 1513 (Kundfordringar: delad faktura), as the balance
   * sheet shows them. 1513 carries the Skatteverket portion
   * of ROT/RUT fakturamodellen invoices until the begäran's payout clears it;
   * ar_ledger_total counts the same share per invoice (skatteverket-share.ts).
   */
  account_1510_balance: number
  difference: number
  is_reconciled: boolean
  /**
   * Number of foreign-currency invoices that lacked an exchange_rate, so their
   * outstanding amount could not be converted to SEK. When > 0 the difference
   * field may be misleading: any reported gap could be missing-data rather
   * than a true reconciliation break.
   */
  unconverted_fx_count: number
  /**
   * True when posted non-invoice-engine AR debit verifikat dated before the
   * register's first invoice exist IN THIS PERIOD (migrated/backfilled
   * invoice history). Only then may a renderer offer "migration" as an
   * explanation for the difference: pre-boundary activity settled in an
   * earlier period contributes nothing to this period's balance, and
   * offering it anyway would cushion a genuine felbokning.
   * Optional so report fixtures elsewhere stay valid; generateARReconciliation
   * always sets it.
   */
  pre_register_ar_in_period?: boolean
}

/**
 * Compare the kundreskontra with accounts 1510 and 1513 at the end of a fiscal
 * year: generateARLedger as of the year's last day against the UB. While the
 * year runs that is the live register (the ledger's rule for today or a date
 * ahead); a past year reads the invoices open on its balansdag, not the ones
 * open today. Account 1510 is debit-normal (asset): balance = debits - credits.
 *
 * Conversion uses each invoice's stored exchange_rate (the invoice-date rate),
 * which matches what was originally posted to 1510. This means the report will
 * diverge from the GL once partial payments settle at a different rate (the
 * delta is correctly booked as valutakursvinst/-förlust to 3960/7960 per
 * ML 8 kap 21-23 §). A subledger-derived total would reconcile through that
 * difference; deferred to a follow-up.
 */
export async function generateARReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string
): Promise<ARReconciliationResult> {
  const asOfDate = await reskontraBalanceDate(supabase, companyId, periodId)

  const [ledger, account1510Balance, preRegisterArInPeriod] = await Promise.all([
    generateARLedger(supabase, companyId, asOfDate ?? undefined, { strict: true }),
    // The booked AR balance: 1510 (Kundfordringar) AND 1513 (Kundfordringar:
    // delad faktura), so the comparison stays correct under ROT/RUT
    // fakturamodellen, where the customer portion sits on 1510 and the
    // Skatteverket claim on 1513: both are open AR receivable from the
    // company's perspective, and the subledger side counts each invoice's
    // Skatteverket share until the begäran's payout clears it.
    //
    // Read as the balance sheet reads it (closingBalanceOf: the trial
    // balance's UB, ingående balans included). The open invoices are every
    // open invoice of the register, whatever year it was booked in, so the
    // ledger side must carry the opening balance too: summing only this
    // fiscal year's verifikat left out an IB carried from earlier years'
    // verifikat and showed that IB as a false difference (crm#1296). Both are
    // debit-normal assets.
    closingBalanceOf(supabase, companyId, periodId, [
      resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable'),
      resolveAccountRole(PINNED_JURISDICTION, 'rot_rut_receivable'),
    ]),
    // Coverage context for the difference. Non-fatal: a failed lookup
    // degrades to "no explanation offered" (the helper returns false on
    // failure), which leaves the red badge standing unqualified rather than
    // excused.
    hasPreRegisterArInPeriod(supabase, companyId, periodId).catch(() => false),
  ])

  const difference = Math.round((ledger.total_outstanding - account1510Balance) * 100) / 100

  return {
    ar_ledger_total: ledger.total_outstanding,
    as_of_date: asOfDate,
    account_1510_balance: Math.round(account1510Balance * 100) / 100,
    difference,
    // BFL 5 kap requires the reconciliation to cover all affärshändelser. If
    // any row was excluded for a missing exchange rate, the calculation is
    // incomplete by construction and we cannot honestly stamp the period
    // Avstämd: the user must fix the underlying data first.
    is_reconciled: Math.abs(difference) < 0.01 && ledger.unconverted_fx_count === 0,
    unconverted_fx_count: ledger.unconverted_fx_count,
    pre_register_ar_in_period: preRegisterArInPeriod,
  }
}
