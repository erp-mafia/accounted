import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import type { VoucherMovements } from '@/lib/reports/kassaflodesanalys-statement'

/**
 * The journal reads of the kassaflödesanalys. Its balances come from
 * generateTrialBalance; what account totals cannot keep is which movements
 * happened together in one voucher, and that is all these reads are for: the
 * income-tax bridge's 2510 evidence (cash-flow-tax.ts) and the statement's
 * gross split of loans and acquisitions and its exchange differences on
 * likvida medel.
 */

/**
 * The entries a kassaflödesanalys reads, beyond company and period: posted
 * and reversed entries (a storno nets its original), less the opening-balance
 * entry (already in IB) and `excludedEntryIds`, the same set the trial balance
 * the statement is built from leaves out.
 */
export interface CashFlowEntryScope {
  openingEntryId: string | null
  excludedEntryIds: readonly string[]
}

/** `scope` as filters on a journal_entries query. */
export function scopeCashFlowEntries(
  query: EntryLinesQuery,
  companyId: string,
  fiscalPeriodId: string,
  scope: CashFlowEntryScope,
): EntryLinesQuery {
  let scoped = query.eq('company_id', companyId).eq('fiscal_period_id', fiscalPeriodId)
    .in('status', ['posted', 'reversed'])
  if (scope.excludedEntryIds.length > 0) scoped = scoped.not('id', 'in', `(${scope.excludedEntryIds.join(',')})`)
  return scope.openingEntryId ? scoped.neq('id', scope.openingEntryId) : scoped
}

/**
 * Net debit per account and voucher. A storno is grouped with the entry it
 * reverses, so a reversed borrowing is neither a borrowing nor an
 * amortisation.
 */
export async function fetchVoucherMovements(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  scope: CashFlowEntryScope,
): Promise<VoucherMovements[]> {
  type Line = {
    account_number: string
    debit_amount: number
    credit_amount: number
    entry?: { id: string; reverses_id: string | null }
  }
  const lines = await fetchEntryLines<Line>({
    supabase,
    entryColumns: 'id, reverses_id',
    lineColumns: 'account_number, debit_amount, credit_amount',
    attachEntriesAs: 'entry',
    filterEntries: (query) => scopeCashFlowEntries(query, companyId, fiscalPeriodId, scope),
  })
  const groups = new Map<string, Map<string, number>>()
  for (const line of lines) {
    const key = line.entry?.reverses_id ?? line.entry?.id ?? ''
    const group = groups.get(key) ?? new Map<string, number>()
    const net = (group.get(line.account_number) ?? 0)
      + (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
    group.set(line.account_number, net)
    groups.set(key, group)
  }
  return [...groups.values()]
}
