/**
 * Where a company's books in Accounted start, for the bank feed: the first
 * import of a new connection asks the bank from here, not for the bank's whole
 * extended history (Swedbank serves 760 days right after the consent). A bank
 * row dated before the books start has no verifikat to land in here: the
 * books for that time are an imported SIE file or another system.
 *
 * The start is (provider-neutral; lib/bank-feed/feed.ts clamps the Open
 * Payments first import with it):
 *   - the day after the company's last imported verifikat (an SIE import or a
 *     provider migration, both journal_entries.source_type 'import'), else
 *     the start of its first fiscal period;
 *   - never later than its first own verifikat (anything but an import or an
 *     opening balance): bookkeeping lags, and a company that books here what
 *     the imported years left open shows the books reach back that far;
 *   - never earlier than the first fiscal period, never later than today.
 * An imported verifikat dated after the day it was imported (an accrual or a
 * plan booked ahead) says nothing about how far the books reach, so it is
 * passed over (and when none of the newest IMPORTED_VOUCHER_SCAN qualifies,
 * the first fiscal period counts instead: the earlier start). A company
 * without a fiscal period (onboarding) has no start: nothing is clamped.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'

/** Imported verifikat read, newest first, to find one not dated ahead of its import. */
export const IMPORTED_VOUCHER_SCAN = 50

/** Sources that are not the company's own bookkeeping here. */
const NOT_OWN_SOURCES = ['import', 'opening_balance'] as const

export interface BooksStartFacts {
  /** period_start of the company's first fiscal period, null when it has none. */
  firstPeriodStart: string | null
  /** entry_date of the latest imported verifikat not dated ahead of its import. */
  lastImportedDate: string | null
  /** entry_date of the company's first own verifikat. */
  firstOwnEntryDate: string | null
}

/** The books' start from the facts, or null when the company has no fiscal period. Pure. */
export function booksStartFrom(facts: BooksStartFacts, today: string): string | null {
  const first = facts.firstPeriodStart
  if (!first) return null
  let start = facts.lastImportedDate ? addDaysIso(facts.lastImportedDate, 1) : first
  if (facts.firstOwnEntryDate && facts.firstOwnEntryDate < start) start = facts.firstOwnEntryDate
  if (start < first) start = first
  if (start > today) start = today
  return start
}

/**
 * The first import's from date, clamped to the books' start: never earlier
 * than the start, and never later than `floor` (today minus the bank's
 * ordinary window), so the clamp only ever cuts the extended history and a
 * first import always gets the ordinary window. Without a start, unchanged.
 */
export function clampToBooksStart(fromDate: string, booksStart: string | null, floor: string): string {
  if (!booksStart) return fromDate
  const target = booksStart < floor ? booksStart : floor
  return fromDate < target ? target : fromDate
}

export interface BooksStartLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * Read the facts and answer the company's books' start, or null when it has
 * no fiscal period or a read fails: an unanswered read never narrows a
 * first import (rows are never lost to a failed lookup), and is logged.
 */
export async function resolveBooksStart(
  supabase: SupabaseClient,
  companyId: string,
  options: { now?: number; log?: BooksStartLogger } = {},
): Promise<string | null> {
  const now = options.now ?? Date.now()
  const failed = (read: string, error: unknown): null => {
    options.log?.warn('books start not read: the first import is not clamped', {
      companyId, read, message: error instanceof Error ? error.message : (error as { message?: string } | null)?.message ?? String(error),
    })
    return null
  }
  try {
    const today = todayIsoStockholm(new Date(now))
    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('period_start')
      .eq('company_id', companyId)
      .order('period_start', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (periodError) return failed('fiscal_periods', periodError)
    const firstPeriodStart = (period as { period_start?: string } | null)?.period_start ?? null
    if (!firstPeriodStart) return null

    const { data: imported, error: importedError } = await supabase
      .from('journal_entries')
      .select('entry_date, created_at')
      .eq('company_id', companyId)
      .eq('source_type', 'import')
      .eq('status', 'posted')
      .lte('entry_date', today)
      .order('entry_date', { ascending: false })
      .limit(IMPORTED_VOUCHER_SCAN)
    if (importedError) return failed('imported_vouchers', importedError)
    const lastImported = ((imported ?? []) as Array<{ entry_date: string; created_at: string | null }>)
      .find((e) => !e.created_at || e.entry_date <= todayIsoStockholm(new Date(e.created_at)))

    const { data: own, error: ownError } = await supabase
      .from('journal_entries')
      .select('entry_date')
      .eq('company_id', companyId)
      .in('status', ['posted', 'reversed'])
      .not('source_type', 'in', `(${NOT_OWN_SOURCES.join(',')})`)
      .order('entry_date', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (ownError) return failed('own_vouchers', ownError)

    return booksStartFrom({
      firstPeriodStart,
      lastImportedDate: lastImported?.entry_date ?? null,
      firstOwnEntryDate: (own as { entry_date?: string } | null)?.entry_date ?? null,
    }, today)
  } catch (error) {
    return failed('unexpected', error)
  }
}
