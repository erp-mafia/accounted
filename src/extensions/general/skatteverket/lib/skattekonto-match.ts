import type { SupabaseClient } from '@supabase/supabase-js'
import type { StoredSkattekontoTransaction } from '../types'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { SKATTEKONTO_ACCOUNT } from '@/lib/skatteverket/manual-verifikat-prefill'
import { loadCancelledEntryIds } from '@/lib/skatteverket/skattekonto-cancelled-entries'
import {
  groupSettlesEntry,
  linkSkattekontoRows,
  SkattekontoLinkError,
} from '@/lib/skatteverket/skattekonto-link'

/**
 * "Matcha mot befintligt verifikat"-flöde för skattekonto-rader.
 *
 * Jacob's use case:
 *   16/3: User books a manual transfer (D 1630 / C 1930, X kr) when they
 *         pay preliminärskatt from the bank.
 *   17/3: Skatteverket reports the same payment landing on skattekontot.
 *
 * Without matching, the per-row Bokför button would create a *second*
 * verifikat with the same 1630-leg → double-counted cash flow. This module
 * finds the existing entry and links the SKV row to it, no new draft.
 *
 * The candidate query is intentionally strict (exact amount, exact side,
 * unused entry): false positives would be silently destructive. False
 * negatives just fall back to "Bokför / Skapa manuellt".
 *
 * AGI period disambiguation: when transaktionstext carries an explicit period
 * token (e.g. "Arbetsgivardeklaration 202605"), the AGI declaration for that
 * period uniquely identifies the salary_run, and from there the salary entries.
 * That lets the matcher prefer the right entry even when two months happen to
 * have identical totals.
 */

const DATE_WINDOW_DAYS = 14
/** Most same-day events combined against one verifikat (tax + avgift + a correction or two). */
const MAX_COMBINED_EVENTS = 4
/** Same-day, same-sign open events considered for a combination; bounds the subset search. */
const MAX_COMBINED_POOL = 10
/**
 * Only a live verifikat carries an event: a reversed one is gone and a
 * cancelled draft (an abandoned or failed booking keeps its lines) never
 * reached the ledger, so neither may be proposed nor block a booking.
 */
const LIVE_ENTRY_STATUSES = ['draft', 'posted']

export class SkattekontoMatchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'TRANSACTION_NOT_FOUND'
      | 'ALREADY_BOOKED'
      | 'ROW_IGNORED'
      | 'ENTRY_NOT_FOUND'
      | 'ENTRY_ALREADY_LINKED'
      | 'INVALID_CANDIDATE',
  ) {
    super(message)
    this.name = 'SkattekontoMatchError'
  }
}

export interface SkattekontoMatchCandidate {
  journal_entry_id: string
  voucher_number: number | null
  voucher_series: string | null
  entry_date: string
  description: string
  status: 'draft' | 'posted' | 'reversed'
  matched_amount: number
  matched_side: 'debit' | 'credit'
  /**
   * True when this candidate was picked because the SKV transaktionstext carried
   * an AGI period code matching the originating salary run. Used by the UI to
   * show a "period-matched" badge.
   */
  matched_via_agi_period?: boolean
  /**
   * True when no single 1630 line equals the amount but the entry's 1630
   * lines NET to it (a manual voucher that split the movement over two
   * lines). The link still settles the whole entry, so the pair closes.
   */
  matched_via_entry_total?: boolean
  /**
   * Present when this row settles the verifikat only TOGETHER with these
   * other open Skatteverket rows (same day, same sign, amounts summing
   * exactly to the 1630 movement, crm#128). Linking links all of them.
   */
  combined_with?: Array<{
    id: string
    transaktionsdatum: string
    transaktionstext: string
    belopp_skatteverket: number
  }>
  /** Absolute sum of this row and combined_with: the 1630 amount the group settles. */
  combined_total?: number
  /**
   * Present when the verifikat already carries links to this many other rows
   * and adding this row keeps the group settling it (crm#104: a payment and
   * a debit booked in one voucher).
   */
  joins_linked_count?: number
}

/** Swedish month names exactly as SKV writes them in prod transaktionstext. */
export const SWEDISH_MONTH_NUMBERS: Record<string, number> = {
  januari: 1,
  februari: 2,
  mars: 3,
  april: 4,
  maj: 5,
  juni: 6,
  juli: 7,
  augusti: 8,
  september: 9,
  oktober: 10,
  november: 11,
  december: 12,
}

const MONTH_NAME_ALTERNATION = Object.keys(SWEDISH_MONTH_NUMBERS).join('|')

// Production skattekonto rows write the period as "<keyword> <månad> <år>"
// ("Avdragen skatt maj 2026", "Arbetsgivaravgift maj 2026"); the numeric
// "Arbetsgivardeklaration 202605" form is what the SKV test environment uses.
const MONTH_NAME_PERIOD_RE = new RegExp(
  `(?:arbetsgivardeklaration|arbetsgivaravgift|avdragen skatt|\\bagi\\b)\\s+(${MONTH_NAME_ALTERNATION})\\s+(\\d{4})\\b`,
  'i',
)

/**
 * Parse an AGI period from a Skatteverket transaktionstext.
 *
 * Examples that match:
 *   "Arbetsgivardeklaration 202605"      (test environment)
 *   "arbetsgivardeklaration 2026-05"
 *   "AGI 202605"
 *   "Avdragen skatt maj 2026"            (production)
 *   "Arbetsgivaravgift maj 2026"         (production)
 *   "Beslut 260703 arbetsgivaravgift mars 2026"  (production beslut rows)
 *
 * Beslut rows parsing to their period is intentional (audited): it lets match
 * suggestions period-boost correction rows too. This is safe because (a) the
 * settlement module never uses parseAgiPeriod; it classifies with its own
 * start-anchored regexes and parseNumericAgiPeriod only, so a beslut row can
 * never mark a period paid, and (b) the only production callers are
 * findMatchSuggestionsBulk and findMatchCandidates in this file, both of which
 * require an exact amount+side match on a 1630 line before suggesting anything,
 * so a beslut row can only ever be suggested against an entry carrying exactly
 * the beslut's amount.
 *
 * Returns null when no period token is present or the value is out of range.
 */
export function parseAgiPeriod(
  transaktionstext: string,
): { year: number; month: number } | null {
  return (
    parseNumericAgiPeriod(transaktionstext) ??
    parseMonthNameAgiPeriod(transaktionstext)
  )
}

/**
 * The numeric-token subset of parseAgiPeriod ("Arbetsgivardeklaration 202605",
 * "AGI 2026-05"). Exported separately because the settlement's combined-row
 * classifier must stay pinned to this form: the month-name form always means
 * the split tax/avgift rows, which settle pairwise.
 *
 * The fallback (numeric YYYYMM after any AGI keyword) covers older SKV variants
 * that omit the leading word but still place the period adjacent to "AGI" or
 * "arbetsgivaravgift" elsewhere in the row.
 */
export function parseNumericAgiPeriod(
  transaktionstext: string,
): { year: number; month: number } | null {
  const text = transaktionstext.toLowerCase()

  const primary = /arbetsgivardeklaration\s*(\d{4})[-]?(\d{2})/i.exec(transaktionstext)
  if (primary) {
    const year = Number(primary[1])
    const month = Number(primary[2])
    if (isValidPeriod(year, month)) return { year, month }
  }

  const agiKeyword = /(arbetsgivardeklaration|arbetsgivaravgift|personalskatt|a-skatt|\bagi\b)/i
  if (!agiKeyword.test(text)) return null

  const fallback = /(\d{4})[-]?(\d{2})\b/.exec(transaktionstext)
  if (fallback) {
    const year = Number(fallback[1])
    const month = Number(fallback[2])
    if (isValidPeriod(year, month)) return { year, month }
  }

  return null
}

function parseMonthNameAgiPeriod(
  transaktionstext: string,
): { year: number; month: number } | null {
  const m = MONTH_NAME_PERIOD_RE.exec(transaktionstext)
  if (!m) return null
  const month = SWEDISH_MONTH_NUMBERS[m[1].toLowerCase()]
  const year = Number(m[2])
  if (month && isValidPeriod(year, month)) return { year, month }
  return null
}

function isValidPeriod(year: number, month: number): boolean {
  return Number.isFinite(year) && Number.isFinite(month)
    && year >= 2000 && year <= 2100
    && month >= 1 && month <= 12
}

interface AgiEntryLookup {
  /** Set of journal_entry_ids that belong to the AGI's salary run for that period. */
  entryIds: Set<string>
}

/**
 * Resolve AGI-linked journal entries for a set of (year, month) periods.
 *
 * For each period: look up agi_declarations (UNIQUE per company per period), then
 * walk salary_runs.salary_entry_id / avgifter_entry_id / vacation_entry_id. Any
 * of those three entries is a legitimate match target for an SKV row carrying
 * the period code.
 */
async function loadAgiEntryIndex(
  supabase: SupabaseClient,
  companyId: string,
  periods: Array<{ year: number; month: number }>,
): Promise<Map<string, AgiEntryLookup>> {
  const index = new Map<string, AgiEntryLookup>()
  if (periods.length === 0) return index

  const uniqueKeys = new Set(periods.map(p => periodKey(p.year, p.month)))
  if (uniqueKeys.size === 0) return index

  const years = Array.from(new Set(periods.map(p => p.year)))
  const months = Array.from(new Set(periods.map(p => p.month)))

  const { data: agiRows } = await supabase
    .from('agi_declarations')
    .select('period_year, period_month, salary_run_id')
    .eq('company_id', companyId)
    .in('period_year', years)
    .in('period_month', months)

  const salaryRunIdsByPeriod = new Map<string, string[]>()
  for (const row of (agiRows ?? []) as Array<{
    period_year: number
    period_month: number
    salary_run_id: string | null
  }>) {
    if (!row.salary_run_id) continue
    const key = periodKey(row.period_year, row.period_month)
    if (!uniqueKeys.has(key)) continue
    const existing = salaryRunIdsByPeriod.get(key) ?? []
    existing.push(row.salary_run_id)
    salaryRunIdsByPeriod.set(key, existing)
  }

  const allSalaryRunIds = Array.from(
    new Set(Array.from(salaryRunIdsByPeriod.values()).flat()),
  )
  if (allSalaryRunIds.length === 0) return index

  const { data: salaryRows } = await supabase
    .from('salary_runs')
    .select('id, salary_entry_id, avgifter_entry_id, vacation_entry_id')
    .eq('company_id', companyId)
    .in('id', allSalaryRunIds)

  const entryIdsByRun = new Map<string, string[]>()
  for (const row of (salaryRows ?? []) as Array<{
    id: string
    salary_entry_id: string | null
    avgifter_entry_id: string | null
    vacation_entry_id: string | null
  }>) {
    const ids = [row.salary_entry_id, row.avgifter_entry_id, row.vacation_entry_id]
      .filter((id): id is string => !!id)
    entryIdsByRun.set(row.id, ids)
  }

  for (const [key, runIds] of salaryRunIdsByPeriod) {
    const entryIds = new Set<string>()
    for (const runId of runIds) {
      for (const id of entryIdsByRun.get(runId) ?? []) entryIds.add(id)
    }
    if (entryIds.size > 0) index.set(key, { entryIds })
  }

  return index
}

function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

/** The 1630 lines of one candidate entry plus the SKV rows already linked to it. */
type EntryHead = {
  id: string
  voucher_number: number | null
  voucher_series: string | null
  entry_date: string
  description: string
  status: 'draft' | 'posted' | 'reversed'
  company_id: string
}
type LineRow = { debit_amount: number; credit_amount: number; journal_entries: EntryHead }
type EntryView = {
  entry: EntryHead
  lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
  /** Amounts of SKV rows already linked to this entry. */
  linked: number[]
}

function buildEntryViews(
  lines: LineRow[],
  linkedRows: Array<{ journal_entry_id: string | null; belopp_skatteverket?: number | string | null }>,
  cancelled: Set<string>,
): Map<string, EntryView> {
  const views = new Map<string, EntryView>()
  for (const line of lines) {
    const e = line.journal_entries
    if (cancelled.has(e.id)) continue
    let view = views.get(e.id)
    if (!view) {
      view = { entry: e, lines: [], linked: [] }
      views.set(e.id, view)
    }
    view.lines.push({
      account_number: SKATTEKONTO_ACCOUNT,
      debit_amount: roundOre(Number(line.debit_amount)),
      credit_amount: roundOre(Number(line.credit_amount)),
    })
  }
  for (const r of linkedRows) {
    if (!r.journal_entry_id) continue
    const view = views.get(r.journal_entry_id)
    // A linked row whose amount is unreadable makes the entry unusable for a
    // group check (NaN never settles), which is the safe direction.
    if (view) view.linked.push(Number(r.belopp_skatteverket))
  }
  return views
}

/** First day of the AGI period every row names, or null when they disagree or name none. */
function sharedPeriodStart(rows: Array<{ transaktionstext?: string | null }>): string | null {
  let key: string | null = null
  for (const r of rows) {
    const p = r.transaktionstext ? parseAgiPeriod(r.transaktionstext) : null
    if (!p) return null
    const k = periodKey(p.year, p.month)
    if (key && key !== k) return null
    key = k
  }
  return key ? `${key}-01` : null
}

/**
 * Date window for a COMBINED match (several same-day events against one
 * verifikat): +/-14 days around the event date, widened back to the first
 * day of the declaration period when every event names the same AGI period
 * ("Avdragen skatt maj 2026" + "Arbetsgivaravgift maj 2026" accept a
 * verifikat dated in May, 2026-05-01 onward). An AGI liability is commonly
 * booked in the salary month while Skatteverket draws it on the 12th of the
 * next month, a 31-day gap on prod (crm#128).
 */
export function combinedMatchWindow(
  eventDate: string,
  rows: Array<{ transaktionstext?: string | null }>,
): { from: string; to: string } {
  const base = addDays(eventDate, -DATE_WINDOW_DAYS)
  const periodStart = sharedPeriodStart(rows)
  return {
    from: periodStart && periodStart < base ? periodStart : base,
    to: addDays(eventDate, DATE_WINDOW_DAYS),
  }
}

/** Every subset of `items` with a size in [minSize, maxSize], smallest first. */
function subsets<T>(items: T[], minSize: number, maxSize: number): T[][] {
  const out: T[][] = []
  const pick = (start: number, acc: T[], size: number) => {
    if (acc.length === size) {
      out.push([...acc])
      return
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i])
      pick(i + 1, acc, size)
      acc.pop()
    }
  }
  for (let size = minSize; size <= Math.min(maxSize, items.length); size++) pick(0, [], size)
  return out
}

/**
 * Bulk-enrich a list of unmatched SKV rows with a `match_suggestion` field
 * pointing to a "high confidence" candidate verifikat.
 *
 * Matching has three layers:
 *   1. AGI period-code disambiguation. If the transaktionstext carries a period
 *      token and the AGI declaration for that period maps to journal entries,
 *      the matcher prefers candidates from that set even when other amount
 *      matches exist.
 *   2. Strict amount+side match. We auto-suggest only when there is EXACTLY ONE
 *      candidate to avoid silently linking the wrong entry. An entry that
 *      already carries links qualifies only when the whole group, this row
 *      included, still settles it (groupSettlesEntry).
 *   3. Combined match (crm#128): rows still without a suggestion that share a
 *      date and a sign are tried in groups of 2 to MAX_COMBINED_EVENTS whose
 *      amounts sum EXACTLY to an unlinked verifikat's 1630 movement, inside
 *      combinedMatchWindow. A group is proposed only when neither the group's
 *      rows nor the verifikat appear in any other combination. Every row of
 *      the group gets the same suggestion, with `combined_with` naming the
 *      others; accepting it links them together or not at all.
 *   4. Interchangeable rows (accounted#1300): rows still without a
 *      suggestion that are identical (same date, amount, sign and text) and
 *      share the same candidates nobody else wants are assigned one to one,
 *      since which identical row links where does not change the ledger.
 *
 * Verifikat that are economically cancelled (a storno pair, in-app or
 * imported, see lib/skatteverket/skattekonto-cancelled-entries.ts) are never
 * candidates.
 */
export async function findMatchSuggestionsBulk(
  supabase: SupabaseClient,
  companyId: string,
  rows: Array<{
    id: string
    transaktionsdatum: string
    transaktionstext?: string | null
    belopp_skatteverket: number
    journal_entry_id: string | null
  }>,
): Promise<Map<string, SkattekontoMatchCandidate>> {
  const unmatched = rows.filter(r => !r.journal_entry_id)
  if (unmatched.length === 0) return new Map()

  const dates = unmatched.map(r => r.transaktionsdatum).sort()
  const widest = unmatched
    .map(r => combinedMatchWindow(r.transaktionsdatum, [r]).from)
    .sort()[0]
  const from = widest < addDays(dates[0], -DATE_WINDOW_DAYS) ? widest : addDays(dates[0], -DATE_WINDOW_DAYS)
  const to = addDays(dates[dates.length - 1], DATE_WINDOW_DAYS)

  // Driven from the journal_entries side (lib/bookkeeping/entry-lines.ts):
  // the scope filters used to sit on a `journal_entries!inner` embed, which
  // PostgREST compiles into a correlated LATERAL join that walks the ENTIRE
  // journal_entry_lines table across all tenants. The parent is reattached
  // under the same `journal_entries` key, so the candidate build is unchanged.
  let lines: LineRow[]
  try {
    lines = await fetchEntryLines<LineRow>({
      supabase,
      entryColumns: 'id, voucher_number, voucher_series, entry_date, description, status, company_id',
      lineColumns: 'debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .gte('entry_date', from)
          .lte('entry_date', to)
          .in('status', LIVE_ENTRY_STATUSES),
      filterLines: (q: EntryLinesQuery) => q.eq('account_number', SKATTEKONTO_ACCOUNT),
    })
  } catch {
    // Unchanged posture: a candidate-search failure yields no suggestions.
    return new Map()
  }

  // SKV rows already linked to a candidate entry, with their amounts: an
  // entry with links is only a candidate for a row that the group check
  // still accepts together with them.
  const candidateEntryIds = Array.from(new Set(lines.map(l => l.journal_entries.id)))
  const { data: linked } = candidateEntryIds.length
    ? await supabase
        .from('skattekonto_transactions')
        .select('journal_entry_id, belopp_skatteverket')
        .eq('company_id', companyId)
        .in('journal_entry_id', candidateEntryIds)
    : { data: [] }

  // AGI period extraction across the batch.
  const periods: Array<{ year: number; month: number }> = []
  const periodByRowId = new Map<string, string>()
  for (const row of unmatched) {
    if (!row.transaktionstext) continue
    const period = parseAgiPeriod(row.transaktionstext)
    if (!period) continue
    periods.push(period)
    periodByRowId.set(row.id, periodKey(period.year, period.month))
  }
  const agiIndex = await loadAgiEntryIndex(supabase, companyId, periods)

  let cancelled: Set<string>
  try {
    cancelled = candidateEntryIds.length
      ? await loadCancelledEntryIds(supabase, companyId, from, to)
      : new Set()
  } catch {
    // Without the storno check no candidate is safe to propose.
    return new Map()
  }

  const entryViews = buildEntryViews(
    lines,
    (linked ?? []) as Array<{ journal_entry_id: string | null; belopp_skatteverket?: number | string | null }>,
    cancelled,
  )

  // Candidates per row, then a one-to-one assignment across rows: two rows
  // that each see "exactly one candidate" must not both be proposed the same
  // verifikat (12 same-day-same-amount groups on prod would have done that).
  // Rows are assigned in date order; AGI-period matches win inside a row.
  const ordered = [...unmatched].sort((a, b) =>
    a.transaktionsdatum < b.transaktionsdatum
      ? -1
      : a.transaktionsdatum > b.transaktionsdatum
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  )
  const candidatesByRow = new Map<string, SkattekontoMatchCandidate[]>()
  const periodIdsByRow = new Map<string, Set<string> | null>()

  for (const row of ordered) {
    const amount = Math.round(Math.abs(Number(row.belopp_skatteverket)) * 100) / 100
    const side = expectedSide(Number(row.belopp_skatteverket))
    const rowFrom = addDays(row.transaktionsdatum, -DATE_WINDOW_DAYS)
    const rowTo = addDays(row.transaktionsdatum, DATE_WINDOW_DAYS)

    const periodEntryIds = (() => {
      const key = periodByRowId.get(row.id)
      return key ? agiIndex.get(key)?.entryIds ?? null : null
    })()
    periodIdsByRow.set(row.id, periodEntryIds)

    const matches: SkattekontoMatchCandidate[] = []
    for (const view of entryViews.values()) {
      const e = view.entry
      if (e.entry_date < rowFrom || e.entry_date > rowTo) continue
      const settles = groupSettlesEntry(view.lines, [...view.linked, Number(row.belopp_skatteverket)])
      if (!settles.ok) continue
      matches.push({
        journal_entry_id: e.id,
        voucher_number: e.voucher_number,
        voucher_series: e.voucher_series,
        entry_date: e.entry_date,
        description: e.description,
        status: e.status,
        matched_amount: amount,
        matched_side: side,
        matched_via_agi_period: periodEntryIds?.has(e.id) ?? false,
        matched_via_entry_total: settles.via === 'entry_total',
        ...(view.linked.length > 0 ? { joins_linked_count: view.linked.length } : {}),
      })
    }
    // Nearest date first so the assignment below is deterministic.
    matches.sort((a, b) => {
      const da = Math.abs(daysBetweenIso(a.entry_date, row.transaktionsdatum))
      const db = Math.abs(daysBetweenIso(b.entry_date, row.transaktionsdatum))
      return da - db || a.journal_entry_id.localeCompare(b.journal_entry_id)
    })
    candidatesByRow.set(row.id, matches)
  }

  const suggestions = new Map<string, SkattekontoMatchCandidate>()
  const usedEntries = new Set<string>()

  const pick = (row: (typeof ordered)[number]): SkattekontoMatchCandidate | null => {
    const free = (candidatesByRow.get(row.id) ?? []).filter(m => !usedEntries.has(m.journal_entry_id))
    const periodEntryIds = periodIdsByRow.get(row.id)
    if (periodEntryIds) {
      const periodMatches = free.filter(m => m.matched_via_agi_period)
      if (periodMatches.length === 1) return periodMatches[0]
    }
    // Only an unambiguous amount match is proposed; a split-line match never
    // outranks a single-line one.
    const exact = free.filter(m => !m.matched_via_entry_total)
    if (exact.length === 1) return exact[0]
    if (exact.length === 0 && free.length === 1) return free[0]
    return null
  }

  // Two passes: rows with an AGI period are the best-informed and go first,
  // then everyone else in date order.
  for (const pass of [true, false]) {
    for (const row of ordered) {
      if (suggestions.has(row.id)) continue
      const hasPeriod = !!periodIdsByRow.get(row.id)
      if (hasPeriod !== pass) continue
      const chosen = pick(row)
      if (!chosen) continue
      suggestions.set(row.id, chosen)
      usedEntries.add(chosen.journal_entry_id)
    }
  }

  // Combined pass, one date group at a time in date order so an earlier
  // group's verifikat is taken before a later group's wider window sees it.
  const groups = new Map<string, typeof ordered>()
  for (const row of ordered) {
    if (suggestions.has(row.id)) continue
    const amount = Number(row.belopp_skatteverket)
    if (!amount) continue
    const key = `${row.transaktionsdatum}|${amount > 0 ? '+' : '-'}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  for (const pool of groups.values()) {
    if (pool.length < 2 || pool.length > MAX_COMBINED_POOL) continue
    const found: Array<{ rows: typeof pool; view: EntryView }> = []
    for (const subset of subsets(pool, 2, MAX_COMBINED_EVENTS)) {
      const window = combinedMatchWindow(subset[0].transaktionsdatum, subset)
      for (const view of entryViews.values()) {
        if (usedEntries.has(view.entry.id) || view.linked.length > 0) continue
        if (view.entry.entry_date < window.from || view.entry.entry_date > window.to) continue
        const settles = groupSettlesEntry(view.lines, subset.map(r => Number(r.belopp_skatteverket)))
        if (settles.ok) found.push({ rows: subset, view })
      }
    }
    for (const m of found) {
      const rowIds = new Set(m.rows.map(r => r.id))
      const contested = found.some(
        o =>
          o !== m &&
          (o.view.entry.id === m.view.entry.id || o.rows.some(r => rowIds.has(r.id))),
      )
      if (contested) continue
      const e = m.view.entry
      const total = roundOre(m.rows.reduce((s, r) => s + Number(r.belopp_skatteverket), 0))
      for (const row of m.rows) {
        suggestions.set(row.id, {
          journal_entry_id: e.id,
          voucher_number: e.voucher_number,
          voucher_series: e.voucher_series,
          entry_date: e.entry_date,
          description: e.description,
          status: e.status,
          matched_amount: roundOre(Math.abs(Number(row.belopp_skatteverket))),
          matched_side: expectedSide(Number(row.belopp_skatteverket)),
          matched_via_agi_period: periodIdsByRow.get(row.id)?.has(e.id) ?? false,
          combined_with: m.rows
            .filter(o => o.id !== row.id)
            .map(o => ({
              id: o.id,
              transaktionsdatum: o.transaktionsdatum,
              transaktionstext: o.transaktionstext ?? '',
              belopp_skatteverket: Number(o.belopp_skatteverket),
            })),
          combined_total: Math.abs(total),
        })
      }
      usedEntries.add(e.id)
    }
  }

  // Interchangeable pass, last so it only fills rows every earlier pass left
  // without a proposal. Identical open rows (same date, amount, sign and
  // text) that all see the same free candidates, which no other open row
  // sees, cannot be told apart: whichever row links to whichever verifikat,
  // the ledger ends up the same. Assign them one to one instead of proposing
  // nothing. Two 1 kr interest rows against two imported 1 kr verifikat got
  // no proposal on prod and were booked a second time. A row that sees more
  // verifikat than there are identical rows (different dates, say) stays
  // ambiguous and unproposed; more identical rows than verifikat leaves the
  // surplus rows (events the ledger lacks) unproposed.
  const identical = new Map<string, typeof ordered>()
  for (const row of ordered) {
    if (suggestions.has(row.id)) continue
    const key = [
      row.transaktionsdatum,
      Math.round(Number(row.belopp_skatteverket) * 100),
      (row.transaktionstext ?? '').trim().toLowerCase(),
    ].join('|')
    const list = identical.get(key) ?? []
    list.push(row)
    identical.set(key, list)
  }
  const freeCandidates = (rowId: string) =>
    (candidatesByRow.get(rowId) ?? []).filter(m => !usedEntries.has(m.journal_entry_id))
  for (const group of identical.values()) {
    if (group.length < 2) continue
    const shared = freeCandidates(group[0].id)
    if (shared.length < 2 || shared.length > group.length) continue
    // Plain single-line matches only: a split-line or joined verifikat is
    // never interchangeable.
    if (shared.some(m => m.matched_via_entry_total || m.joins_linked_count)) continue
    const sharedIds = new Set(shared.map(m => m.journal_entry_id))
    const sameSet = group.every(r => {
      const free = freeCandidates(r.id)
      return free.length === sharedIds.size && free.every(m => sharedIds.has(m.journal_entry_id))
    })
    if (!sameSet) continue
    const groupIds = new Set(group.map(r => r.id))
    const contested = ordered.some(
      o =>
        !groupIds.has(o.id) &&
        !suggestions.has(o.id) &&
        freeCandidates(o.id).some(m => sharedIds.has(m.journal_entry_id)),
    )
    if (contested) continue
    shared.forEach((entry, i) => {
      const row = group[i]
      const own = freeCandidates(row.id).find(m => m.journal_entry_id === entry.journal_entry_id)
      if (!own) return
      suggestions.set(row.id, own)
    })
    for (const id of sharedIds) usedEntries.add(id)
  }

  return suggestions
}

function daysBetweenIso(a: string, b: string): number {
  const ms = new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()
  return Math.round(ms / 86_400_000)
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function expectedSide(beloppSkatteverket: number): 'debit' | 'credit' {
  // Positive SKV amount = money INTO skattekonto = 1630 increases = DEBIT 1630
  // Negative SKV amount = money OUT of skattekonto = 1630 decreases = CREDIT 1630
  return beloppSkatteverket > 0 ? 'debit' : 'credit'
}

/**
 * Find existing journal entries that look like the ledger side of this
 * skattekonto row.
 *
 * Three kinds of candidate, all exact to the öre on 1630:
 *   * a verifikat whose 1630 movement this row settles on its own (+/-14 days);
 *   * a verifikat already linked to other rows that, with this row added,
 *     the group still settles (+/-14 days; crm#104);
 *   * a verifikat whose 1630 movement this row settles TOGETHER with other
 *     open same-day, same-sign rows (combinedMatchWindow; crm#128). The
 *     candidate names those rows in `combined_with` and linking it links all
 *     of them.
 * Cancelled verifikat (storno pairs) are never listed.
 *
 * Returns up to 25 candidates ordered by AGI-period match, then date proximity
 * to the SKV row.
 */
export async function findMatchCandidates(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
): Promise<{ tx: StoredSkattekontoTransaction; candidates: SkattekontoMatchCandidate[] }> {
  const { data: tx, error: txError } = await supabase
    .from('skattekonto_transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single<StoredSkattekontoTransaction>()

  if (txError || !tx) {
    throw new SkattekontoMatchError(
      'Skattekonto-transaktionen hittades inte.',
      'TRANSACTION_NOT_FOUND',
    )
  }

  if (tx.journal_entry_id) {
    throw new SkattekontoMatchError(
      'Transaktionen är redan kopplad till ett verifikat.',
      'ALREADY_BOOKED',
    )
  }

  const byRow = await findLedgerTwinCandidates(supabase, companyId, [tx])
  return { tx, candidates: (byRow.get(tx.id) ?? []).slice(0, 25) }
}

/**
 * findLedgerTwinCandidates for rows given by id: reads the rows first and
 * searches only the open ones (not linked, not ignored). A booked, ignored or
 * unknown id is left out of the map; the booking gates answer for those.
 */
export async function findLedgerTwinCandidatesForIds(
  supabase: SupabaseClient,
  companyId: string,
  ids: string[],
): Promise<Map<string, SkattekontoMatchCandidate[]>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase
    .from('skattekonto_transactions')
    .select('id, transaktionsdatum, transaktionstext, belopp_skatteverket')
    .eq('company_id', companyId)
    .in('id', ids)
    .eq('is_ignored', false)
    .is('journal_entry_id', null)
  if (error) throw searchFailed(error.message)
  return findLedgerTwinCandidates(supabase, companyId, (data ?? []) as LedgerTwinProbe[])
}

/** The fields of an open Skatteverket row the candidate search reads. */
export interface LedgerTwinProbe {
  id: string
  transaktionsdatum: string
  transaktionstext?: string | null
  belopp_skatteverket: number | string
}

type CompanionRow = {
  id: string
  transaktionsdatum: string
  transaktionstext: string | null
  belopp_skatteverket: number | string
}

const SEARCH_FAILED_PREFIX = 'Kunde inte söka kandidater'

function searchFailed(err: unknown): Error {
  return new Error(`${SEARCH_FAILED_PREFIX}: ${err instanceof Error ? err.message : String(err)}`)
}

/** Max journal_entry ids per `.in()` filter on the link read (URL length). */
const LINKED_ID_CHUNK = 100

/**
 * Every candidate verifikat for each of `probes`: the ledger entries that
 * already carry the row's event, by the definition documented on
 * findMatchCandidates (exact to the öre on 1630, alone, joined to rows
 * already linked, or combined with other open same-day rows; storno pairs
 * never count). The window data (1630 entries, links, AGI entries, same-day
 * open rows, storno pairs) is read once per cluster of rows whose windows lie
 * close together (clusterProbesByWindow), so a batch of rows in one month
 * costs the same handful of queries as one row, and a batch spread over
 * years reads only the rows' own windows, not everything in between.
 *
 * This is both the match dialog's list and the booking guard's "the ledger
 * already has this event" test (skattekonto-booking.ts): one definition, so
 * a refused booking always points at candidates the match dialog shows.
 *
 * Returns an entry for every probe (an empty list when nothing matches),
 * ordered AGI-period match first, then date proximity, then voucher number
 * descending. Throws when any read fails: without the links or the storno
 * check no answer is safe.
 */
export async function findLedgerTwinCandidates(
  supabase: SupabaseClient,
  companyId: string,
  probes: LedgerTwinProbe[],
): Promise<Map<string, SkattekontoMatchCandidate[]>> {
  const out = new Map<string, SkattekontoMatchCandidate[]>()
  for (const p of probes) out.set(p.id, [])
  if (probes.length === 0) return out

  // One window read per cluster of rows whose windows lie close together,
  // never one read across the whole span of a batch: two rows years apart
  // must not pull every verifikat in between. A row only ever uses entries
  // inside its own window, so every row still sees all its candidates, and
  // an isolated row gets exactly the read the single-row search makes.
  for (const cluster of clusterProbesByWindow(probes)) {
    const found = await searchLedgerTwinWindow(supabase, companyId, cluster)
    for (const [id, candidates] of found) out.set(id, candidates)
  }
  return out
}

/**
 * Rows whose windows lie at most this many days apart share one window read:
 * reading a short gap costs less than a second round of queries.
 */
const TWIN_WINDOW_MERGE_GAP_DAYS = 31

/** The entry dates a row's candidates can have: [combined window start, date + 14 days]. */
function probeWindow(p: LedgerTwinProbe): { from: string; to: string } {
  return {
    from: combinedMatchWindow(p.transaktionsdatum, [p]).from,
    to: addDays(p.transaktionsdatum, DATE_WINDOW_DAYS),
  }
}

/**
 * Split probes into groups whose windows overlap or lie within
 * TWIN_WINDOW_MERGE_GAP_DAYS of each other, so a read covers the rows'
 * windows and short gaps only, never the whole span of a batch.
 */
export function clusterProbesByWindow<T extends LedgerTwinProbe>(probes: T[]): T[][] {
  const sorted = probes
    .map(p => ({ p, w: probeWindow(p) }))
    .sort((a, b) => (a.w.from < b.w.from ? -1 : a.w.from > b.w.from ? 1 : 0))
  const clusters: T[][] = []
  let current: T[] = []
  let currentTo = ''
  for (const { p, w } of sorted) {
    if (current.length > 0 && w.from > addDays(currentTo, TWIN_WINDOW_MERGE_GAP_DAYS)) {
      clusters.push(current)
      current = []
      currentTo = ''
    }
    current.push(p)
    if (!currentTo || w.to > currentTo) currentTo = w.to
  }
  if (current.length > 0) clusters.push(current)
  return clusters
}

/** findLedgerTwinCandidates for one cluster of probes: one read of their joint window. */
async function searchLedgerTwinWindow(
  supabase: SupabaseClient,
  companyId: string,
  probes: LedgerTwinProbe[],
): Promise<Map<string, SkattekontoMatchCandidate[]>> {
  const out = new Map<string, SkattekontoMatchCandidate[]>()
  for (const p of probes) out.set(p.id, [])

  // Widest window any probe's candidate can use (a combined candidate may
  // reach back to its AGI period start); per-row windows are applied below.
  let from = ''
  let to = ''
  for (const p of probes) {
    const pFrom = combinedMatchWindow(p.transaktionsdatum, [p]).from
    const pTo = addDays(p.transaktionsdatum, DATE_WINDOW_DAYS)
    if (!from || pFrom < from) from = pFrom
    if (!to || pTo > to) to = pTo
  }

  // Every 1630 line of the entries in the window; the amount test runs in
  // memory because a combined or joined candidate does not carry the row's
  // amount on any line. The scope sits on the journal_entries side (see
  // lib/bookkeeping/entry-lines.ts for why an !inner embed is not used).
  let typedRows: LineRow[]
  try {
    typedRows = await fetchEntryLines<LineRow>({
      supabase,
      entryColumns: 'id, voucher_number, voucher_series, entry_date, description, status, company_id',
      lineColumns: 'debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .gte('entry_date', from)
          .lte('entry_date', to)
          .in('status', LIVE_ENTRY_STATUSES),
      filterLines: (q: EntryLinesQuery) => q.eq('account_number', SKATTEKONTO_ACCOUNT),
    })
  } catch (err) {
    throw searchFailed(err)
  }

  if (typedRows.length === 0) return out

  // Rows already linked to a candidate entry, with their amounts. A failed
  // read throws: treating a linked entry as unlinked would invent a twin.
  const candidateEntryIds = Array.from(new Set(typedRows.map(r => r.journal_entries.id)))
  const linked: Array<{ journal_entry_id: string | null; belopp_skatteverket?: number | string | null }> = []
  for (let i = 0; i < candidateEntryIds.length; i += LINKED_ID_CHUNK) {
    const { data, error } = await supabase
      .from('skattekonto_transactions')
      .select('journal_entry_id, belopp_skatteverket')
      .eq('company_id', companyId)
      .in('journal_entry_id', candidateEntryIds.slice(i, i + LINKED_ID_CHUNK))
    if (error) throw searchFailed(error.message)
    linked.push(...((data ?? []) as typeof linked))
  }

  // AGI-linked entries for every period the probes name.
  const periodKeyByProbe = new Map<string, string>()
  const periods: Array<{ year: number; month: number }> = []
  for (const p of probes) {
    const period = p.transaktionstext ? parseAgiPeriod(p.transaktionstext) : null
    if (!period) continue
    periods.push(period)
    periodKeyByProbe.set(p.id, periodKey(period.year, period.month))
  }
  const agiIndex = periods.length
    ? await loadAgiEntryIndex(supabase, companyId, periods)
    : new Map<string, AgiEntryLookup>()

  // Open rows on the probes' dates: the pool a combined candidate draws from.
  const dates = Array.from(new Set(probes.map(p => p.transaktionsdatum)))
  let companionData: CompanionRow[]
  try {
    companionData = await fetchAllRows<CompanionRow>(
      ({ from: rangeFrom, to: rangeTo }) =>
        supabase
          .from('skattekonto_transactions')
          .select('id, transaktionsdatum, transaktionstext, belopp_skatteverket')
          .eq('company_id', companyId)
          .in('transaktionsdatum', dates)
          .eq('status', 'booked')
          .eq('is_ignored', false)
          .is('journal_entry_id', null)
          .order('id', { ascending: true })
          .range(rangeFrom, rangeTo),
      { dedupeBy: (r) => r.id },
    )
  } catch (err) {
    throw searchFailed(err)
  }
  const openByDate = new Map<string, CompanionRow[]>()
  for (const c of companionData) {
    const list = openByDate.get(c.transaktionsdatum) ?? []
    list.push(c)
    openByDate.set(c.transaktionsdatum, list)
  }

  let cancelled: Set<string>
  try {
    cancelled = await loadCancelledEntryIds(supabase, companyId, from, to)
  } catch (err) {
    throw searchFailed(err)
  }

  const views = buildEntryViews(typedRows, linked, cancelled)

  for (const p of probes) {
    const belopp = Number(p.belopp_skatteverket)
    const amount = Math.round(Math.abs(belopp) * 100) / 100
    const side = expectedSide(belopp)
    const singleFrom = addDays(p.transaktionsdatum, -DATE_WINDOW_DAYS)
    const singleTo = addDays(p.transaktionsdatum, DATE_WINDOW_DAYS)
    // The widest window any of this row's candidates can use: a combined
    // group only reaches back to the period start this row names itself.
    const probeFrom = combinedMatchWindow(p.transaktionsdatum, [p]).from
    const pKey = periodKeyByProbe.get(p.id)
    const periodEntryIds = pKey ? agiIndex.get(pKey)?.entryIds ?? null : null

    // Open same-day, same-sign rows that may settle a verifikat together
    // with this one: the first MAX_COMBINED_POOL other open same-sign rows of
    // the day (an opposite-sign row can never be part of the group, so it
    // must not take a slot).
    const companions = (openByDate.get(p.transaktionsdatum) ?? [])
      .filter(c => c.id !== p.id)
      .filter(c => Math.sign(Number(c.belopp_skatteverket)) === Math.sign(belopp) && belopp !== 0)
      .slice(0, MAX_COMBINED_POOL)
    const companionSubsets = subsets(companions, 1, MAX_COMBINED_EVENTS - 1)

    const candidates: SkattekontoMatchCandidate[] = []
    for (const view of views.values()) {
      const e = view.entry
      // A batch reads one window for all rows; skip what this row cannot reach.
      if (e.entry_date < probeFrom || e.entry_date > singleTo) continue
      const base = {
        journal_entry_id: e.id,
        voucher_number: e.voucher_number,
        voucher_series: e.voucher_series,
        entry_date: e.entry_date,
        description: e.description,
        status: e.status,
        matched_amount: amount,
        matched_side: side,
        matched_via_agi_period: periodEntryIds?.has(e.id) ?? false,
      }
      const nearby = e.entry_date >= singleFrom && e.entry_date <= singleTo
      if (nearby) {
        const settles = groupSettlesEntry(view.lines, [...view.linked, belopp])
        if (settles.ok) {
          candidates.push({
            ...base,
            ...(settles.via === 'entry_total' ? { matched_via_entry_total: true } : {}),
            ...(view.linked.length > 0 ? { joins_linked_count: view.linked.length } : {}),
          })
          continue
        }
      }
      if (view.linked.length > 0) continue
      for (const subset of companionSubsets) {
        const window = combinedMatchWindow(p.transaktionsdatum, [p, ...subset])
        if (e.entry_date < window.from || e.entry_date > window.to) continue
        const amounts = [belopp, ...subset.map(c => Number(c.belopp_skatteverket))]
        if (!groupSettlesEntry(view.lines, amounts).ok) continue
        candidates.push({
          ...base,
          combined_with: subset.map(c => ({
            id: c.id,
            transaktionsdatum: c.transaktionsdatum,
            transaktionstext: c.transaktionstext ?? '',
            belopp_skatteverket: Number(c.belopp_skatteverket),
          })),
          combined_total: Math.abs(roundOre(amounts.reduce((s, a) => s + a, 0))),
        })
        break // smallest group first; one proposal per verifikat
      }
    }

    // Order: AGI-period match first, then date proximity, then voucher number desc.
    const target = new Date(p.transaktionsdatum + 'T00:00:00Z').getTime()
    candidates.sort((a, b) => {
      if (a.matched_via_agi_period !== b.matched_via_agi_period) {
        return a.matched_via_agi_period ? -1 : 1
      }
      const da = Math.abs(new Date(a.entry_date + 'T00:00:00Z').getTime() - target)
      const db = Math.abs(new Date(b.entry_date + 'T00:00:00Z').getTime() - target)
      if (da !== db) return da - db
      return (b.voucher_number ?? 0) - (a.voucher_number ?? 0)
    })
    out.set(p.id, candidates)
  }

  return out
}

const LINK_TO_MATCH_CODE: Record<string, SkattekontoMatchError['code']> = {
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  ALREADY_BOOKED: 'ALREADY_BOOKED',
  ROW_IGNORED: 'ROW_IGNORED',
  ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
  ENTRY_ALREADY_LINKED: 'ENTRY_ALREADY_LINKED',
  INVALID_CANDIDATE: 'INVALID_CANDIDATE',
  LINK_RACE: 'ENTRY_ALREADY_LINKED',
  NOT_LINKED: 'INVALID_CANDIDATE',
}

/**
 * Link a skattekonto_transactions row to an existing journal entry.
 *
 * Re-validates the candidate server-side: the entry must still belong to
 * the company and its 1630 movement must be settled by this row together
 * with any rows already linked to it (groupSettlesEntry). With
 * `alsoTransactionIds` (a combined candidate) the whole group is linked in
 * one all-or-nothing write by the core helper.
 */
export async function matchSkattekontoToEntry(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  journalEntryId: string,
  alsoTransactionIds: string[] = [],
): Promise<void> {
  const others = [...new Set(alsoTransactionIds)].filter(id => id !== transactionId)
  if (others.length > 0) {
    try {
      await linkSkattekontoRows(supabase, companyId, [transactionId, ...others], journalEntryId)
      return
    } catch (err) {
      if (err instanceof SkattekontoLinkError) {
        throw new SkattekontoMatchError(err.message, LINK_TO_MATCH_CODE[err.code] ?? 'INVALID_CANDIDATE')
      }
      throw err
    }
  }

  const { data: tx, error: txError } = await supabase
    .from('skattekonto_transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single<StoredSkattekontoTransaction>()

  if (txError || !tx) {
    throw new SkattekontoMatchError(
      'Skattekonto-transaktionen hittades inte.',
      'TRANSACTION_NOT_FOUND',
    )
  }
  if (tx.journal_entry_id) {
    throw new SkattekontoMatchError(
      'Transaktionen är redan kopplad till ett verifikat.',
      'ALREADY_BOOKED',
    )
  }

  // Same gate as bokforSkattekontoTransaction: an ignored row was explicitly
  // triaged off the work list, so linking it to a verifikat must first be
  // preceded by an explicit unignore.
  if (tx.is_ignored) {
    throw new SkattekontoMatchError(
      'Transaktionen är ignorerad. Återställ den innan du bokför.',
      'ROW_IGNORED',
    )
  }

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select(
      `
        id,
        status,
        lines:journal_entry_lines (
          account_number,
          debit_amount,
          credit_amount
        )
      `,
    )
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .single()

  if (entryError || !entry) {
    throw new SkattekontoMatchError(
      'Verifikatet hittades inte.',
      'ENTRY_NOT_FOUND',
    )
  }
  if (entry.status === 'reversed') {
    throw new SkattekontoMatchError(
      'Verifikatet är makulerat och kan inte matchas.',
      'INVALID_CANDIDATE',
    )
  }

  // Rows already on this verifikat join the check (crm#104): the entry is
  // only "taken" when the group with this row added no longer settles it.
  const { data: linkedData } = await supabase
    .from('skattekonto_transactions')
    .select('id, belopp_skatteverket')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
  const linkedRows = (Array.isArray(linkedData) ? linkedData : linkedData ? [linkedData] : []) as Array<{
    id: string
    belopp_skatteverket?: number | string | null
  }>
  type Line = { account_number: string; debit_amount: number; credit_amount: number }
  const settles = groupSettlesEntry(entry.lines as Line[] | null, [
    ...linkedRows.map(r => Number(r.belopp_skatteverket)),
    Number(tx.belopp_skatteverket),
  ])
  if (!settles.ok) {
    if (linkedRows.length > 0) {
      throw new SkattekontoMatchError(
        'Verifikatet är redan kopplat till en annan skattekonto-transaktion.',
        'ENTRY_ALREADY_LINKED',
      )
    }
    throw new SkattekontoMatchError(
      'Verifikatet saknar en matchande rad på 1630.',
      'INVALID_CANDIDATE',
    )
  }

  const { error: updateError } = await supabase
    .from('skattekonto_transactions')
    .update({ journal_entry_id: journalEntryId })
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .is('journal_entry_id', null) // guard against concurrent updates

  if (updateError) {
    throw new Error(`Kunde inte koppla transaktionen: ${updateError.message}`)
  }
}
