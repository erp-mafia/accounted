import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { createLogger } from '@/lib/logger'

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
  return Math.round(sum * 100) / 100
}
