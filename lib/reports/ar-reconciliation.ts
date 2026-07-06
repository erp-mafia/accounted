import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

export interface ARReconciliationResult {
  ar_ledger_total: number
  /**
   * Sum of posted balances on accounts 1510 (Kundfordringar) and 1513
   * (Kundfordringar: delad faktura). 1513 covers the Skatteverket portion
   * of ROT/RUT fakturamodellen invoices and is zero today (no fakturamodellen
   * postings yet): included for forward compatibility.
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
  // Paginated: a company with >1000 open invoices would otherwise be silently
  // truncated, manufacturing a phantom reconciliation gap.
  const invoices = await fetchAllRows<{
    id: string
    total: number | null
    paid_amount: number | null
    currency: string | null
    exchange_rate: number | null
  }>(({ from, to }) =>
    supabase
      .from('invoices')
      .select('id, total, paid_amount, currency, exchange_rate')
      .eq('company_id', companyId)
      .in('status', ['sent', 'overdue'])
      .order('id', { ascending: true })
      .range(from, to)
  )

  let unconvertedFxCount = 0
  const arLedgerTotal = (invoices || [])
    .reduce((sum, inv) => {
      const isFx = inv.currency && inv.currency !== 'SEK'
      const hasRate = inv.exchange_rate != null && Number(inv.exchange_rate) > 0
      // Skip unconvertible FX rows from the sum: adding raw foreign amounts
      // to a SEK total is arithmetically unsound. Counted instead.
      if (isFx && !hasRate) {
        unconvertedFxCount += 1
        return sum
      }
      const outstanding = (Number(inv.total) || 0) - (Number(inv.paid_amount) || 0)
      const sek = resolveSekAmount(outstanding, null, inv.currency, inv.exchange_rate)
      return Math.round((sum + sek) * 100) / 100
    }, 0)

  // Get AR receivable balance from the ledger in this period. We sum 1510
  // (Kundfordringar) AND 1513 (Kundfordringar: delad faktura) so the comparison
  // stays correct under ROT/RUT fakturamodellen, where the customer portion sits
  // on 1510 and the Skatteverket claim on 1513: both are open AR receivable
  // from the company's perspective. 1513 is zero today (no fakturamodellen
  // postings yet) so this is a forward-looking defense.
  //
  // We count posted AND reversed entries together: the SAME inclusion rule the
  // trial balance / balance sheet use. A corrected invoice flips its original to
  // status='reversed'; that reversed leg is cancelled by the posted storno, so
  // both must be summed or a corrected invoice manufactures a phantom gap.
  // Paginated with a stable id order (+ dedupe defense) so a period with >1000
  // ledger lines on 1510/1513 isn't silently truncated into a phantom gap.
  const journalLines = await fetchAllRows<{
    id: string
    debit_amount: number | null
    credit_amount: number | null
  }>(({ from, to }) =>
    supabase
      .from('journal_entry_lines')
      .select(`
        id,
        debit_amount,
        credit_amount,
        journal_entry:journal_entries!inner(
          status,
          company_id,
          fiscal_period_id
        )
      `)
      .in('account_number', ['1510', '1513'])
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', periodId)
      .in('journal_entries.status', ['posted', 'reversed'])
      .order('id', { ascending: true })
      .range(from, to)
  , { dedupeBy: (l) => l.id })

  // Both 1510 and 1513 are debit-normal assets: balance = debits - credits
  let account1510Balance = 0
  for (const line of journalLines) {
    account1510Balance = Math.round((account1510Balance + (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)) * 100) / 100
  }

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
  }
}
