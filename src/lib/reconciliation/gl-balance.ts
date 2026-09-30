import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'

const log = createLogger('reconciliation/gl-balance')

/**
 * The journal_entries statuses that make up a ledger balance.
 *
 * Storno keeps the original entry in the books with status 'reversed' and
 * posts a separate reversal (source_type 'storno', status 'posted'). A
 * balance therefore has to count BOTH: the trial balance
 * (lib/reports/trial-balance.ts) and the bank reconciliation engine
 * (lib/reconciliation/bank-reconciliation.ts) already do. Summing 'posted'
 * alone excludes the reversed original while including its reversal, which
 * double-cancels the movement and misstates the account by the reversed
 * amount. The skattekonto drift check did exactly that until 2026-08-23.
 */
export const LEDGER_BALANCE_STATUSES = ['posted', 'reversed'] as const

export interface SumAccountBalanceOptions {
  /** Inclusive upper bound on entry_date (YYYY-MM-DD). */
  cutoffDate?: string
  /** Inclusive lower bound on entry_date (YYYY-MM-DD). */
  fromDate?: string
  /** Exclusive upper bound on entry_date (YYYY-MM-DD); combines with fromDate. */
  beforeDate?: string
}

/**
 * Sum debit - credit on one BAS account over posted + reversed entries.
 *
 * Returns null (NOT 0) when the read fails: 0 is a real balance claim
 * ("nothing booked on this account"), and substituting it for a failed read
 * turns a transient DB blip into a full-balance difference. Callers decide
 * whether to skip or to surface the failure.
 *
 * Driven from the journal_entries side via fetchEntryLines so the tenant
 * scope never compiles into a cross-tenant LATERAL scan, and both steps
 * paginate (PostgREST caps at 1000 rows).
 */
export async function sumAccountBalance(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string,
  options: SumAccountBalanceOptions = {},
): Promise<number | null> {
  let rows: Array<{ debit_amount: number | string | null; credit_amount: number | string | null }>
  try {
    rows = await fetchEntryLines({
      supabase,
      lineColumns: 'debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) => {
        let query = q
          .eq('company_id', companyId)
          .in('status', [...LEDGER_BALANCE_STATUSES])
        if (options.cutoffDate) query = query.lte('entry_date', options.cutoffDate)
        if (options.fromDate) query = query.gte('entry_date', options.fromDate)
        if (options.beforeDate) query = query.lt('entry_date', options.beforeDate)
        return query
      },
      filterLines: (q: EntryLinesQuery) => q.eq('account_number', accountNumber),
      attachEntriesAs: null,
    })
  } catch (err) {
    log.warn('sumAccountBalance failed', {
      companyId,
      accountNumber,
      options,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  let sum = 0
  for (const row of rows) {
    sum += Number(row.debit_amount || 0) - Number(row.credit_amount || 0)
  }
  return roundOre(sum)
}

export interface OpeningBalanceFloor {
  /** The IB date: the first day of the fiscal year it opens. */
  date: string
  /** Net debit - credit of the IB lines on the account. */
  amount: number
  /** The IB verifikat (normally one; same-date duplicates are all counted). */
  entryIds: string[]
}

interface OpeningBalanceLineRow {
  debit_amount: number | string | null
  credit_amount: number | string | null
  journal_entries?: { id: string; entry_date: string; status: string; source_type: string | null }
}

/**
 * The latest ingående balans (IB) on one account dated on or before cutoffDate.
 *
 * An IB restates everything booked before it: year-end rollover, SIE import
 * and set_opening_balances each post one opening_balance verifikat on the
 * fiscal year's first day, and the prior years' detail stays in the ledger.
 * A balance that sums across the IB counts those years twice, so balance
 * readers floor at it (the bank engine does the same, issue #751).
 *
 * Only a POSTED opening_balance entry dated on the first day of a fiscal year
 * counts. A stornerad IB is nulled by its storno, and prod holds ordinary
 * payments that an import labelled opening_balance in mid-year: flooring at
 * one of those would drop months of real movement.
 *
 * Returns null when the account has no IB. Throws on a read failure: the
 * floor decides what the balance is, so a caller must not guess it.
 */
export async function findOpeningBalanceFloor(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string,
  cutoffDate: string,
): Promise<OpeningBalanceFloor | null> {
  const lines = await fetchEntryLines<OpeningBalanceLineRow>({
    supabase,
    entryColumns: 'id, entry_date, status, source_type',
    lineColumns: 'debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) =>
      q
        .eq('company_id', companyId)
        .eq('status', 'posted')
        .eq('source_type', 'opening_balance')
        .lte('entry_date', cutoffDate),
    filterLines: (q: EntryLinesQuery) => q.eq('account_number', accountNumber),
  })
  const candidates = lines.flatMap((l) => {
    const entry = l.journal_entries
    return entry && entry.status === 'posted' && entry.source_type === 'opening_balance' ? [{ entry, line: l }] : []
  })
  if (candidates.length === 0) return null

  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('period_start')
    .eq('company_id', companyId)
    .in('period_start', Array.from(new Set(candidates.map((c) => c.entry.entry_date))))
  if (error) throw new Error(`Kunde inte läsa räkenskapsår: ${error.message}`)
  const yearStarts = new Set(((data ?? []) as Array<{ period_start: string }>).map((p) => p.period_start))

  const ib = candidates.filter((c) => yearStarts.has(c.entry.entry_date))
  if (ib.length === 0) return null
  const date = ib.reduce((latest, c) => (c.entry.entry_date > latest ? c.entry.entry_date : latest), ib[0].entry.entry_date)
  let amount = 0
  const entryIds = new Set<string>()
  for (const { entry, line } of ib) {
    if (entry.entry_date !== date) continue
    amount += Number(line.debit_amount || 0) - Number(line.credit_amount || 0)
    entryIds.add(entry.id)
  }
  return { date, amount: roundOre(amount), entryIds: Array.from(entryIds) }
}
