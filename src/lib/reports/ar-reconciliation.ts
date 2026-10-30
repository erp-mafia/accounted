import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { hasPreRegisterArInPeriod } from '@/lib/reports/invoice-register-coverage'
import {
  liveReceivableOutstanding,
  skatteverketSettledByInvoice,
} from '@/lib/bookkeeping/skatteverket-share'
import { creditNoteCreditUsed, outstandingWithCreditUsed } from './credit-note-settlement'
import { fetchArLedgerInvoices } from './ar-ledger-invoices'
import { closingBalanceOf } from './trial-balance'

export interface ARReconciliationResult {
  ar_ledger_total: number
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
 * Compare sum of open customer invoices against account 1510 balance.
 * Account 1510 is debit-normal (asset): balance = debits - credits.
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

  // total/paid_amount are stored in invoice currency; account 1510 is in SEK
  // (booked at invoice-date rate), so convert each row before summing.
  // The open invoices are the live kundreskontra's whole population (one
  // read, ar-ledger-invoices.ts): a partially paid invoice still carries
  // total - paid_amount on 1510, a paid one with a ROT/RUT deduction can
  // still carry Skatteverket's share on 1513, and a 'credited' original
  // still carries its debit, which its credit note's own row (Cr 1510)
  // nets. The 1510 balance and the coverage context are read beside it.
  const [population, account1510Balance, preRegisterArInPeriod] = await Promise.all([
    fetchArLedgerInvoices(supabase, companyId),
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
  // In id order, the order the sum below has always run in: each step rounds.
  // The same rows the kundreskontra sums (generateARLedger). Leaving the
  // credited originals out while their credit notes stayed in counted each
  // credit against nothing, and the register fell short of 1510 by exactly
  // the credited amount (crm#1537).
  const invoices = [...population].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // A credit note whose verifikat paid another invoice has used that much of
  // its credit: the kundreskontra's rule (credit-note-settlement.ts).
  const creditUsed = creditNoteCreditUsed(invoices)
  // What Skatteverket has paid out of each invoice's deduction, which no
  // longer sits on 1513: the kundreskontra's rule (skatteverket-share.ts).
  const settled = skatteverketSettledByInvoice(invoices)

  let unconvertedFxCount = 0
  const arLedgerTotal = (invoices || [])
    .reduce((sum, inv) => {
      const outstanding = outstandingWithCreditUsed(
        liveReceivableOutstanding(
          inv,
          (Number(inv.total) || 0) - (Number(inv.paid_amount) || 0),
          settled.get(inv.id)
        ),
        creditUsed.get(inv.id)
      )
      // A paid invoice Skatteverket has settled in full is not a receivable.
      if (inv.status === 'paid' && outstanding === 0) return sum
      const isFx = inv.currency && inv.currency !== 'SEK'
      const hasRate = inv.exchange_rate != null && Number(inv.exchange_rate) > 0
      // Skip unconvertible FX rows from the sum: adding raw foreign amounts
      // to a SEK total is arithmetically unsound. Counted instead.
      if (isFx && !hasRate) {
        unconvertedFxCount += 1
        return sum
      }
      const sek = resolveSekAmount(outstanding, null, inv.currency, inv.exchange_rate)
      return Math.round((sum + sek) * 100) / 100
    }, 0)

  const difference = Math.round((arLedgerTotal - account1510Balance) * 100) / 100

  return {
    ar_ledger_total: Math.round(arLedgerTotal * 100) / 100,
    account_1510_balance: Math.round(account1510Balance * 100) / 100,
    difference,
    // BFL 5 kap requires the reconciliation to cover all affärshändelser. If
    // any row was excluded for a missing exchange rate, the calculation is
    // incomplete by construction and we cannot honestly stamp the period
    // Avstämd: the user must fix the underlying data first.
    is_reconciled: Math.abs(difference) < 0.01 && unconvertedFxCount === 0,
    unconverted_fx_count: unconvertedFxCount,
    pre_register_ar_in_period: preRegisterArInPeriod,
  }
}
