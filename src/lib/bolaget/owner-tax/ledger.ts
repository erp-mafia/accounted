/**
 * Ledger balances of the owner loan accounts on a day, for the register's
 * reconciliation. Read-only.
 *
 * A balance counts posted AND reversed entries: storno keeps the original
 * with status 'reversed' and posts the reversal separately, so summing
 * 'posted' alone would double-cancel a reversed movement (the same rule as
 * lib/reconciliation/gl-balance.ts and the trial balance).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { roundOre } from '@/lib/money'

const LEDGER_BALANCE_STATUSES = ['posted', 'reversed'] as const

/**
 * Debit minus credit per account, through `day` inclusive. A failed read
 * answers null for every account (never 0: 0 is a real balance claim).
 */
export async function loanAccountBalances(supabase: SupabaseClient, companyId: string, accounts: readonly string[], day: string): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  const unique = [...new Set(accounts)]
  if (unique.length === 0) return out
  try {
    const rows = (await fetchEntryLines({
      supabase,
      lineColumns: 'account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) => q.eq('company_id', companyId).in('status', [...LEDGER_BALANCE_STATUSES]).lte('entry_date', day),
      filterLines: (q: EntryLinesQuery) => q.in('account_number', unique),
      attachEntriesAs: null,
    })) as Array<{ account_number: string; debit_amount: number | string | null; credit_amount: number | string | null }>
    for (const account of unique) out.set(account, 0)
    for (const row of rows) {
      out.set(row.account_number, roundOre((out.get(row.account_number) ?? 0) + Number(row.debit_amount || 0) - Number(row.credit_amount || 0)))
    }
  } catch {
    for (const account of unique) out.set(account, null)
  }
  return out
}
