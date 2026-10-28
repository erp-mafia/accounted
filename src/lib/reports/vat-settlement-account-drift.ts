/**
 * Moms that Skatteverket has already charged or paid out but that still sits
 * on the redovisningskonto för moms (2650) or the momsfordran (1650).
 *
 * A momsredovisning moves a period's net onto 2650 (to pay) or 1650 (to get
 * back); Skatteverket debits or pays it on the period's deadline, at the
 * latest about 130 days after the period ends (a yearly filer's 12 May). So
 * on any date the two accounts may hold only what was moved onto them in the
 * last 150 days. Whatever exceeds that is older moms whose charge or payout
 * was never booked against the account: the 2026-10-26 forensic sweep found
 * 176 active companies with such moms built up while they booked in Accounted,
 * with Skatteverket's moms rows left unbooked or ignored, and nothing checked
 * that 2650 clears (the VAT settlement check stops at 26xx into 2650).
 *
 * Deadline-free on purpose. A company that dates the momsredovisning on
 * Skatteverket's charge day, or clears 26xx straight against 1630, never
 * carries anything here and is never flagged. The balance is taken oldest
 * first: every credit to 2650 (debit to 1650) inside the window counts as
 * recent, whatever booked it, so one payment covering two periods, a storno
 * pair or a migrated opening balance never reads as drift.
 *
 * What was already stale on the day of the last imported verifikat is the
 * previous system's and reported apart (inherited_*): the finding is what
 * built up since.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { addDaysIso } from '@/lib/dates/iso'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { VAT_REFUND_ACCOUNT, VAT_SETTLEMENT_ACCOUNT } from '@/lib/reports/vat-settlement'

/** Days a period's net may lie on 2650/1650 before Skatteverket has charged or paid it. */
export const SETTLEMENT_WINDOW_DAYS = 150

export interface SettlementAccountDrift {
  as_of: string
  /** Moms att betala on 2650 older than the window, built up since the last import. */
  payable_drift: number
  /** Moms att få tillbaka on 1650 older than the window, built up since the last import. */
  receivable_drift: number
  /** What was already stale on 2650 and 1650 at the last imported verifikat. */
  inherited_payable: number
  inherited_receivable: number
}

export interface SettlementDayRow {
  account_number: string
  entry_date: string
  debit: number | string
  credit: number | string
}

/** The stale part of each account on `date`: its balance less what came onto it in the window before. */
function staleOn(rows: readonly SettlementDayRow[], date: string): { payable: number; receivable: number } {
  const windowStart = addDaysIso(date, -(SETTLEMENT_WINDOW_DAYS - 1))
  let payable = 0
  let receivable = 0
  for (const row of rows) {
    if (row.entry_date > date) continue
    const debit = Number(row.debit) || 0
    const credit = Number(row.credit) || 0
    const recent = row.entry_date >= windowStart
    if (row.account_number === VAT_SETTLEMENT_ACCOUNT) {
      payable += credit - debit - (recent ? credit : 0)
    } else {
      receivable += debit - credit - (recent ? debit : 0)
    }
  }
  return { payable: Math.max(0, roundOre(payable)), receivable: Math.max(0, roundOre(receivable)) }
}

/** Pure core: the drift on `asOf`, less what was already stale at `cutover` (the last imported verifikat). */
export function settlementAccountDrift(rows: readonly SettlementDayRow[], asOf: string, cutover: string | null): SettlementAccountDrift {
  const now = staleOn(rows, asOf)
  const inherited = cutover && cutover < asOf ? staleOn(rows, cutover) : { payable: 0, receivable: 0 }
  return {
    as_of: asOf,
    payable_drift: Math.max(0, roundOre(now.payable - inherited.payable)),
    receivable_drift: Math.max(0, roundOre(now.receivable - inherited.receivable)),
    inherited_payable: inherited.payable,
    inherited_receivable: inherited.receivable,
  }
}

export async function computeSettlementAccountDrift(
  supabase: SupabaseClient,
  companyId: string,
  asOf: string,
): Promise<SettlementAccountDrift> {
  const [rows, lastImport] = await Promise.all([
    fetchAllRows<SettlementDayRow>(({ from, to }) =>
      supabase
        .from('ledger_account_days')
        .select('account_number, entry_date, debit, credit')
        .eq('company_id', companyId)
        .in('account_number', [VAT_SETTLEMENT_ACCOUNT, VAT_REFUND_ACCOUNT])
        .lte('entry_date', asOf)
        .order('entry_date', { ascending: true })
        .order('account_number', { ascending: true })
        .range(from, to),
    ),
    supabase
      .from('journal_entries')
      .select('entry_date')
      .eq('company_id', companyId)
      .eq('source_type', 'import')
      .in('status', ['posted', 'reversed'])
      .order('entry_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  if (lastImport.error) throw new Error(`last imported verifikat: ${lastImport.error.message}`)
  const cutover = (lastImport.data as { entry_date: string } | null)?.entry_date ?? null
  return settlementAccountDrift(rows, asOf, cutover)
}
