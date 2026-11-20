import type { SourceFilter } from '@/components/transactions/transaction-types'
import { isWithinBounds, type PeriodBounds } from '@/lib/transactions/period-filter'

/**
 * Scoping for the Transaktioner inbox ("Att bokföra"): which pending rows the
 * active source and period filters show, and how many they hide.
 *
 * What counts as pending is decided by the caller (the page's bank and
 * skattekonto predicates, mirroring lib/worklist). This module only scopes:
 * the list and the tab badge read the same source predicate here, so the
 * badge cannot count rows the list does not show (crm#1056, crm#1043).
 */

/**
 * Whether a bank row belongs to the source the picker shows. 'all' and 'bank'
 * (the plain split used before any cash account is registered) take every bank
 * row; 'acct:<id>' takes that cash account's rows; 'bank:other' takes the rows
 * not yet tied to a registered cash account; 'skatteverket' takes none.
 */
export function bankRowInSource(
  cashAccountId: string | null | undefined,
  source: SourceFilter,
): boolean {
  if (source === 'skatteverket') return false
  if (source.startsWith('acct:')) return cashAccountId === source.slice('acct:'.length)
  if (source === 'bank:other') return cashAccountId == null
  return true
}

/** Skattekonto rows belong to no cash account: only 'all' and 'skatteverket' show them. */
export function skattekontoInSource(source: SourceFilter): boolean {
  return source === 'all' || source === 'skatteverket'
}

export interface InboxScopeInput {
  /** Pending bank rows (the page's unbooked predicate already applied). */
  bankRows: readonly { id: string; date: string; cash_account_id?: string | null }[]
  /** Pending skattekonto rows (no verifikat, not ignored). */
  skattekontoRows: readonly { id: string; transaktionsdatum: string }[]
  /** The source the page actually filters by (the effective one). */
  source: SourceFilter
  /** Active period bounds, or null for every fiscal year. */
  period: PeriodBounds | null
  /**
   * Rows on their way out (just booked, ignored or deleted, still rendering
   * for the exit animation). They are handled already, so no count includes
   * them: the badge drops on the click, not 350ms later.
   */
  leaving?: ReadonlySet<string>
}

export interface InboxScopeCounts {
  /** Pending rows the active source and period show: the "Att bokföra" badge. */
  inScope: number
  /** Pending rows inside the period that the source filter hides. */
  hiddenBySource: number
  /** Pending rows of every source outside the period. */
  outsidePeriod: number
}

/**
 * Splits every pending row into exactly one of three buckets, so
 * inScope + hiddenBySource + outsidePeriod is the whole backlog: nothing
 * pending disappears without a number saying where it went (BFL 5 kap:
 * affärshändelser are booked promptly, so a filter must never hide them
 * silently).
 */
export function countInboxScope({
  bankRows,
  skattekontoRows,
  source,
  period,
  leaving,
}: InboxScopeInput): InboxScopeCounts {
  const counts: InboxScopeCounts = { inScope: 0, hiddenBySource: 0, outsidePeriod: 0 }
  const tally = (date: string, inSource: boolean) => {
    if (!isWithinBounds(date, period)) counts.outsidePeriod += 1
    else if (inSource) counts.inScope += 1
    else counts.hiddenBySource += 1
  }
  for (const row of bankRows) {
    if (leaving?.has(row.id)) continue
    tally(row.date, bankRowInSource(row.cash_account_id, source))
  }
  const skattekontoShown = skattekontoInSource(source)
  for (const row of skattekontoRows) {
    if (leaving?.has(row.id)) continue
    tally(row.transaktionsdatum, skattekontoShown)
  }
  return counts
}
