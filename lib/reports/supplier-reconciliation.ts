import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

export interface ReconciliationResult {
  supplier_ledger_total: number
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
 * ML 8 kap 21–23 §). A subledger-derived total would reconcile through that
 * difference; deferred to a follow-up.
 */
export async function generateReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string
): Promise<ReconciliationResult> {

  // remaining_amount is stored in invoice currency; account 2440 is in SEK
  // (booked at invoice-date rate), so convert each row before summing.
  // Paginated: a company with >1000 open supplier invoices would otherwise be
  // silently truncated, manufacturing a phantom reconciliation gap.
  const invoices = await fetchAllRows<{
    id: string
    remaining_amount: number | null
    currency: string | null
    exchange_rate: number | null
  }>(({ from, to }) =>
    supabase
      .from('supplier_invoices')
      .select('id, remaining_amount, currency, exchange_rate')
      .eq('company_id', companyId)
      .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
      .order('id', { ascending: true })
      .range(from, to)
  )

  let unconvertedFxCount = 0
  const supplierLedgerTotal = (invoices || [])
    .reduce((sum, inv) => {
      const isFx = inv.currency && inv.currency !== 'SEK'
      const hasRate = inv.exchange_rate != null && Number(inv.exchange_rate) > 0
      // Skip unconvertible FX rows from the sum — adding raw foreign amounts
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

  // Get account 2440 balance from the ledger in this period. We count posted
  // AND reversed entries together — the SAME inclusion rule the trial balance /
  // balance sheet use. A corrected supplier invoice flips its original
  // registration to status='reversed' (storno-service.ts); that reversed credit
  // on 2440 is cancelled by the posted storno's debit, so BOTH legs must be
  // summed or the report double-counts the payment debit and shows a phantom
  // debit balance. (This is exactly the false −41 121,25 kr "Ej avstämd" gap a
  // fully-paid, fully-corrected company hit: posted-only = −41 121,25, but
  // posted+reversed = 0, matching the leverantörsreskontra.)
  // Paginated with a stable id order (+ dedupe defense) so a period with >1000
  // ledger lines on 2440 isn't silently truncated into a phantom gap.
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
      .eq('account_number', '2440')
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', periodId)
      .in('journal_entries.status', ['posted', 'reversed'])
      .order('id', { ascending: true })
      .range(from, to)
  , { dedupeBy: (l) => l.id })

  // Account 2440 is a liability: credit normal balance
  // Balance = credits - debits
  let account2440Balance = 0
  for (const line of journalLines) {
    account2440Balance = Math.round((account2440Balance + (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0)) * 100) / 100
  }

  const difference = Math.round((supplierLedgerTotal - account2440Balance) * 100) / 100

  return {
    supplier_ledger_total: Math.round(supplierLedgerTotal * 100) / 100,
    account_2440_balance: Math.round(account2440Balance * 100) / 100,
    difference,
    // BFL 5 kap requires the reconciliation to cover all affärshändelser. If
    // any row was excluded for a missing exchange rate, the calculation is
    // incomplete by construction and we cannot honestly stamp the period
    // Avstämd — the user must fix the underlying data first.
    is_reconciled: Math.abs(difference) < 0.01 && unconvertedFxCount === 0,
    unconverted_fx_count: unconvertedFxCount,
  }
}
