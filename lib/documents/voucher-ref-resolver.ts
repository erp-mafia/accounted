/**
 * Resolve a SOURCE-system voucher reference to the gnubok verifikat it became.
 *
 * The SIE importer renumbers vouchers per target series (so source `A31` may
 * land as `A47` here), but it preserves the source identity on every entry:
 * `journal_entries.source_voucher_series` + `source_voucher_number`, written by
 * the `import_sie_journal_entries` RPC straight from #VER. That pair is the only
 * safe join key back to the old system. Matching on our own `voucher_number`
 * instead silently attaches underlag to the wrong verifikat as soon as the
 * import skipped an empty or unbalanced voucher, which it routinely does.
 *
 * Two consumers, one resolution truth:
 *  - the provider migration sweep (Bokio/Fortnox), which knows each attachment's
 *    voucher ref AND its date/financial year, and
 *  - the underlag file import, which only knows what the filename says.
 *
 * Hence two entry points: `resolveDatedRef` when a date narrows the candidates,
 * and `candidatesForRef` when it does not and the caller must handle ambiguity
 * itself (surface the choice rather than guess: an underlag on the wrong
 * verifikat is räkenskapsinformation and cannot be re-pointed afterwards).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/** A voucher as written in the source system. */
export interface SourceVoucherRef {
  series: string
  number: number
}

/** A source ref plus the date window that narrows it to one fiscal year. */
export interface DatedSourceVoucherRef extends SourceVoucherRef {
  /** Attachment date, or the financial year start when only that is known. */
  date: string
  /** Financial year end, when the source only pins the attachment to a year. */
  dateTo?: string
}

export interface VoucherRow {
  id: string
  fiscal_period_id: string
  entry_date: string
  source_voucher_series: string | null
  source_voucher_number: number | null
  // Display-only, and fetched only by the reads that need them: the provider
  // sweep resolves thousands of entries and never renders any of this.
  description?: string | null
  voucher_series?: string | null
  voucher_number?: number | null
}

export interface FiscalPeriodRow {
  id: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

export interface VoucherIndex {
  /**
   * (period, series, number) → entry id, for keys that resolve to exactly one
   * verifikat. Keys seen more than once are removed and recorded as ambiguous.
   */
  byPeriodKey: Map<string, string>
  /** "series|number" → every entry carrying it, across all fiscal years. */
  bySourceRef: Map<string, VoucherRow[]>
  /** number → every entry carrying it in ANY series, for series-less filenames. */
  byNumber: Map<number, VoucherRow[]>
  ambiguousPeriodKeys: Set<string>
}

/** Find the fiscal period whose date range contains a given date. */
export function periodIdForDate(periods: FiscalPeriodRow[], date: string): string | null {
  const period = periods.find((p) => p.period_start <= date && date <= p.period_end)
  return period?.id ?? null
}

/**
 * Series comparison is case-insensitive on both sides of the join. SIE writes
 * series uppercase in practice but the spec does not require it, and a filename
 * is whatever the user's export tool produced: `a31.pdf` must still find `A31`.
 */
function normalizeSeries(series: string): string {
  return series.trim().toUpperCase()
}

/**
 * In-memory key for a verifikat: fiscal period + series + number. Scoping by
 * period is essential: source systems restart voucher numbering every year, so
 * `A31` alone is not unique once several years are migrated.
 */
export function voucherKey(periodId: string, series: string, number: number): string {
  return `${periodId}|${normalizeSeries(series)}|${number}`
}

/** "series|number", the period-agnostic key. */
export function sourceRefKey(series: string, number: number): string {
  return `${normalizeSeries(series)}|${number}`
}

export function buildVoucherIndex(vouchers: VoucherRow[]): VoucherIndex {
  const byPeriodKey = new Map<string, string>()
  const bySourceRef = new Map<string, VoucherRow[]>()
  const byNumber = new Map<number, VoucherRow[]>()
  const ambiguousPeriodKeys = new Set<string>()

  // Get-or-create + push, never copy: the provider sweep indexes every
  // migrated entry in the company, and per-row array copies turn that O(n²).
  const appendTo = <K,>(map: Map<K, VoucherRow[]>, key: K, row: VoucherRow) => {
    const list = map.get(key)
    if (list) list.push(row)
    else map.set(key, [row])
  }

  for (const v of vouchers) {
    if (v.source_voucher_series == null || v.source_voucher_number == null) continue

    appendTo(bySourceRef, sourceRefKey(v.source_voucher_series, v.source_voucher_number), v)
    appendTo(byNumber, v.source_voucher_number, v)

    const key = voucherKey(v.fiscal_period_id, v.source_voucher_series, v.source_voucher_number)
    if (byPeriodKey.has(key)) {
      // Two entries share one source ref inside one fiscal year: neither can be
      // chosen without guessing, so drop both rather than attach blind.
      byPeriodKey.delete(key)
      ambiguousPeriodKeys.add(key)
    } else if (!ambiguousPeriodKeys.has(key)) {
      byPeriodKey.set(key, v.id)
    }
  }

  return { byPeriodKey, bySourceRef, byNumber, ambiguousPeriodKeys }
}

/**
 * Resolve a ref that carries date information. Returns undefined when the ref
 * matches nothing or is ambiguous: callers count it as unmatched, never guess.
 */
export function resolveDatedRef(
  index: VoucherIndex,
  periods: FiscalPeriodRow[],
  ref: DatedSourceVoucherRef,
): string | undefined {
  if (ref.dateTo) {
    // The source pinned the attachment to a financial year, not a day: accept
    // it only when exactly one migrated verifikat in that window carries the ref.
    const candidates = (index.bySourceRef.get(sourceRefKey(ref.series, ref.number)) ?? []).filter(
      (voucher) => ref.date <= voucher.entry_date && voucher.entry_date <= ref.dateTo!,
    )
    return candidates.length === 1 ? candidates[0].id : undefined
  }

  const periodId = periodIdForDate(periods, ref.date)
  return periodId ? index.byPeriodKey.get(voucherKey(periodId, ref.series, ref.number)) : undefined
}

/**
 * Every migrated verifikat carrying a source ref, across all fiscal years.
 * A filename gives no date, so a ref that hits several years is genuinely
 * ambiguous and the caller must ask instead of picking one.
 */
export function candidatesForRef(index: VoucherIndex, ref: SourceVoucherRef): VoucherRow[] {
  return index.bySourceRef.get(sourceRefKey(ref.series, ref.number)) ?? []
}

/**
 * Candidates for a filename that carried a number but no series (`31.pdf`).
 * Searches every series, so this is only usable when it yields exactly one hit,
 * and the caller must still make a human confirm it.
 */
export function candidatesForNumber(index: VoucherIndex, number: number): VoucherRow[] {
  return index.byNumber.get(number) ?? []
}

// Both selects are written out inline at their call site rather than hoisted
// into a shared constant. tests/schema/no-phantom-columns.test.ts resolves
// column lists by scanning the AST for string literals passed to .select();
// a constant is opaque to it, and hiding this query surface would drop all
// eight journal_entries columns out of the phantom-column net on the one code
// path that writes irreversible räkenskapsinformation links.

/**
 * Statuses a resolved verifikat may have to receive underlag. Posted is the
 * normal case; reversed stays in, because a storno'd original remains
 * räkenskapsinformation and its underlag belongs on it. Draft and cancelled
 * are excluded: the SIE import RPC posts every entry inside its own
 * transaction, so a draft with a source ref should be unobservable, but the
 * link is irreversible, and an invariant that lives in another file is not an
 * invariant this module may lean on.
 */
const ATTACHABLE_STATUSES = ['posted', 'reversed']

/**
 * All entries that carry a source voucher ref, resolution columns only.
 *
 * A stable `.order('id')` is required: fetchAllRows pages with `.range()`, and
 * PostgREST paging without a deterministic order can skip or repeat rows once
 * the table exceeds one page (journal_entries crosses 1000 after a couple of
 * migrated years), which would defeat both resolution and any dedup built on it.
 */
export async function fetchSourceRefVouchers(
  supabase: SupabaseClient,
  companyId: string,
): Promise<VoucherRow[]> {
  return fetchAllRows<VoucherRow>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select('id, fiscal_period_id, entry_date, source_voucher_series, source_voucher_number')
      .eq('company_id', companyId)
      .not('source_voucher_number', 'is', null)
      .in('status', ATTACHABLE_STATUSES)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

/** PostgREST puts `.in()` lists in the URL, so the filter is chunked. */
const REF_QUERY_CHUNK = 200

/**
 * Only the entries that could match one of `numbers`, rather than every
 * migrated entry in the company. The filename flow resolves a handful of refs
 * per request and would otherwise pull thousands of rows into memory each time.
 * Series is filtered in memory afterwards: it is case-insensitive here and a
 * series-less filename has to search across all of them anyway.
 *
 * Carries the display columns too, because this is the read behind a plan the
 * user has to be able to read before approving it.
 *
 * `fiscalPeriodId` narrows the read at the DB. It is an OPTIMIZATION, not the
 * enforcement: buildUnderlagPlan re-filters the rows in memory before indexing,
 * and that in-memory filter is the line the year guarantee rests on.
 */
export async function fetchVouchersForNumbers(
  supabase: SupabaseClient,
  companyId: string,
  numbers: number[],
  fiscalPeriodId?: string,
): Promise<VoucherRow[]> {
  const unique = [...new Set(numbers)]
  if (unique.length === 0) return []

  const rows: VoucherRow[] = []
  for (let i = 0; i < unique.length; i += REF_QUERY_CHUNK) {
    const chunk = unique.slice(i, i + REF_QUERY_CHUNK)
    const chunkRows = await fetchAllRows<VoucherRow>(({ from, to }) => {
      let query = supabase
        .from('journal_entries')
        .select(
          'id, fiscal_period_id, entry_date, description, voucher_series, voucher_number, source_voucher_series, source_voucher_number',
        )
        .eq('company_id', companyId)
        .in('source_voucher_number', chunk)
        .in('status', ATTACHABLE_STATUSES)
      if (fiscalPeriodId) query = query.eq('fiscal_period_id', fiscalPeriodId)
      return query.order('id', { ascending: true }).range(from, to)
    })
    rows.push(...chunkRows)
  }
  return rows
}

/**
 * Whether a fiscal year holds any SIE-imported entry carrying a source ref.
 * Distinguishes "the filenames are wrong" from "this year was never imported
 * from SIE", which are the same empty plan on screen but different problems.
 */
export async function hasSourceRefVouchers(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .not('source_voucher_number', 'is', null)

  if (error) throw new Error(`Failed to count migrated vouchers: ${error.message}`)
  return (count ?? 0) > 0
}

export async function fetchFiscalPeriods(
  supabase: SupabaseClient,
  companyId: string,
): Promise<FiscalPeriodRow[]> {
  return fetchAllRows<FiscalPeriodRow>(({ from, to }) =>
    supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end, is_closed, locked_at')
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

/** Our own label for a verifikat (`A47`), as opposed to the source label. */
export function voucherLabel(entry: Pick<VoucherRow, 'voucher_series' | 'voucher_number'>): string | null {
  return entry.voucher_series && entry.voucher_number != null
    ? `${entry.voucher_series}${entry.voucher_number}`
    : null
}

/** The label the source system used (`A31`), which is what filenames carry. */
export function sourceVoucherLabel(
  entry: Pick<VoucherRow, 'source_voucher_series' | 'source_voucher_number'>,
): string | null {
  return entry.source_voucher_series && entry.source_voucher_number != null
    ? `${entry.source_voucher_series}${entry.source_voucher_number}`
    : null
}
