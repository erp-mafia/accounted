import type { SupabaseClient } from '@supabase/supabase-js'
import type { CashAccount } from '@/types'
import { fetchEntryLines } from '@/lib/bookkeeping/entry-lines'
import { physicalAccountKey } from '@/lib/cash-accounts/ledger-slots'
import { createLogger } from '@/lib/logger'

/**
 * Reconnect duplicates: one bank account on two cash_accounts rows. Which rows
 * those are and which one stands for the account going forward. Apart from the
 * chart writers in service.ts, so a list the client bundle reaches can fold
 * them without pulling in the BAS reference data.
 */

const log = createLogger('cash-accounts')

/**
 * The physicalKeyById sameCashAccount needs for these row ids. Read only when
 * they name a second account, which few rows do. A failed read answers no
 * keys: the rows then read as two accounts, the guard's fail-open answer.
 */
export async function readPhysicalKeys(
  supabase: SupabaseClient,
  companyId: string,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<ReadonlyMap<string, string>> {
  const keys = new Map<string, string>()
  const distinct = [...new Set(ids.filter((id): id is string => !!id))]
  if (distinct.length < 2) return keys
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('id, iban, currency')
    .eq('company_id', companyId)
    .in('id', distinct)
  if (error) {
    log.warn('physical account keys read failed; rows read as two accounts', { companyId, error: error.message })
    return keys
  }
  for (const row of (data ?? []) as Array<{ id: string; iban: string | null; currency: string | null }>) {
    const key = physicalAccountKey(row)
    if (key) keys.set(row.id, key)
  }
  return keys
}

/**
 * The subset of `ledgers` that carry bookkeeping history: at least one line on
 * a posted or reversed verifikat. Driven from the journal_entries side (see
 * lib/bookkeeping/entry-lines.ts); only called when a company actually has
 * twin rows, so the entry scan is paid on the rare path.
 */
export async function ledgersWithPostedLines(
  supabase: SupabaseClient,
  companyId: string,
  ledgers: string[],
): Promise<Set<string>> {
  if (ledgers.length === 0) return new Set()
  const lines = await fetchEntryLines<{ account_number: string }>({
    supabase,
    lineColumns: 'account_number',
    filterEntries: (q) => q.eq('company_id', companyId).in('status', ['posted', 'reversed']),
    filterLines: (q) => q.in('account_number', ledgers),
    attachEntriesAs: null,
  })
  return new Set(lines.map((l) => l.account_number))
}

/** What {@link pickKeeper} needs to rank the rows of one physical account. */
export type TwinCandidate = Pick<CashAccount, 'id' | 'ledger_account' | 'is_primary' | 'created_at'>

/**
 * Reconnect duplicates among `rows`: one bank account on two rows. Row id ->
 * the row that stands for it going forward (pickKeeper), so every list counts
 * and signs the account on one row; a caller folds the ids away, it never drops
 * them from the books. An account split over two ledgers has no keeper, and a
 * failed read has no answer: their rows are not folded.
 */
export async function supersededTwins<T extends TwinCandidate & { iban?: string | null; currency?: string | null }>(
  supabase: SupabaseClient,
  companyId: string,
  rows: readonly T[],
): Promise<Map<string, string>> {
  const superseded = new Map<string, string>()
  const byAccount = new Map<string, T[]>()
  for (const row of rows) {
    const key = physicalAccountKey(row)
    if (key) byAccount.set(key, [...(byAccount.get(key) ?? []), row])
  }
  const groups = [...byAccount.values()].filter((group) => group.length > 1)
  if (groups.length === 0) return superseded
  let posted: Set<string>
  try {
    posted = await ledgersWithPostedLines(supabase, companyId, groups.flat().map((row) => row.ledger_account))
  } catch (err) {
    log.warn('twin ledger read failed; no row is folded', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return superseded
  }
  for (const group of groups) {
    const keeper = pickKeeper(group, posted)
    if (!keeper) continue
    for (const row of group) {
      if (row.id !== keeper.id) superseded.set(row.id, keeper.id)
    }
  }
  return superseded
}

/**
 * Which of several rows for ONE physical account (same IBAN + currency) is the
 * account going forward. The signal is bookkeeping HISTORY, not liveness (two
 * liveness signals were contradicted by prod, see DECISIONS.md 2026-08-28):
 * the row whose ledger already carries posted lines keeps the bank account on
 * one ledger; then the primary row; then the oldest.
 *
 * Returns null when MORE than one ledger carries posted lines: the account is
 * already split across two ledgers, no automatic choice is safe, and any
 * correction there is a storno the user has to decide on.
 */
export function pickKeeper<T extends TwinCandidate>(
  rows: readonly T[],
  postedLedgers: ReadonlySet<string>,
): T | null {
  const withHistory = rows.filter((r) => postedLedgers.has(r.ledger_account))
  if (withHistory.length > 1) return null
  if (withHistory.length === 1) return withHistory[0]
  const primary = rows.find((r) => r.is_primary)
  if (primary) return primary
  return (
    [...rows].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    )[0] ?? null
  )
}
