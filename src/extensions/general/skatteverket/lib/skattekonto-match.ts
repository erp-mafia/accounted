import type { SupabaseClient } from '@supabase/supabase-js'
import type { StoredSkattekontoTransaction } from '../types'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveSkattekontoAccount, type SkattekontoLedgerAccount } from '@/lib/skatteverket/skattekonto-account'
import { loadCancelledEntryIds } from '@/lib/skatteverket/skattekonto-cancelled-entries'
import {
  evaluateSkattekontoLink,
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
/** Most events combined against one verifikat (tax + avgift + a correction or two). */
const MAX_COMBINED_EVENTS = 4
/** Open events considered in one combination search; bounds the subset search. */
const MAX_COMBINED_POOL = 10
/**
 * How far from a row's own date another open row may lie and still be tried
 * together with it by the single-row search (crm#1147). A ticked selection
 * (findGroupMatchCandidates) has no such bound: its rows are the user's own.
 */
const COMPANION_WINDOW_DAYS = DATE_WINDOW_DAYS
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
   * other open Skatteverket rows, their amounts summing exactly to the 1630
   * movement: rows of one sign, of the same day (crm#128) or, from the
   * single-row search, up to 14 days away (crm#1147), or same-day rows of
   * both signs whose net it is, under the stricter mixed-group rules
   * (crm#1004, see unambiguousCombinedMatches). Linking links all of them.
   */
  combined_with?: Array<{
    id: string
    transaktionsdatum: string
    transaktionstext: string
    belopp_skatteverket: number
  }>
  /** Absolute net of this row and combined_with: the 1630 amount the group settles. */
  combined_total?: number
  /**
   * Present when the verifikat already carries links to this many other rows
   * and adding this row keeps the group settling it (crm#104: a payment and
   * a debit booked in one voucher). Together with combined_with: the rows
   * already linked, this row and the combined rows explain the verifikat's
   * whole 1630 movement (crm#1147).
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

/** The skattekonto-account lines of one candidate entry plus the SKV rows already linked to it. */
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
  account: SkattekontoLedgerAccount,
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
      account_number: account,
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

/**
 * The entry dates a GROUP of rows can settle, whatever the rows' dates: from
 * combinedMatchWindow's start for the earliest row (widened to a declaration
 * month every row names) to 14 days after the latest. For rows of one day it
 * is combinedMatchWindow itself. One definition for a ticked selection
 * (findGroupMatchCandidates) and for the groups the single-row search builds
 * around a row (searchLedgerTwinWindow), so the same rows are never judged by
 * two date rules (crm#1147).
 */
export function groupMatchWindow(
  rows: Array<{ transaktionsdatum: string; transaktionstext?: string | null }>,
): { from: string; to: string } {
  const dates = rows.map(r => r.transaktionsdatum).sort()
  return {
    from: combinedMatchWindow(dates[0], rows).from,
    to: addDays(dates[dates.length - 1], DATE_WINDOW_DAYS),
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

/** True when the amounts hold both a movement into the skattekonto and one out of it. */
function mixesSigns(amounts: number[]): boolean {
  return amounts.some(a => a > 0) && amounts.some(a => a < 0)
}

/**
 * True when a proper, non-empty part of the group nets to exactly zero (öre).
 * That part moves nothing on 1630, so the rest of the group settles the
 * verifikat without it and the group is never the verifikat's explanation
 * (crm#1004). On prod most same-day groups of both signs that hit a
 * verifikat do so only through such a part: an inbetalning and the debit it
 * paid, or a beslut that reverses a fee, next to the event the verifikat
 * really carries. A group of one sign never has such a part.
 */
function hasZeroSumPart(amounts: number[]): boolean {
  const ore = amounts.map(a => Math.round(a * 100))
  const whole = (1 << ore.length) - 1
  for (let part = 1; part < whole; part++) {
    let sum = 0
    for (let i = 0; i < ore.length; i++) if (part & (1 << i)) sum += ore[i]
    if (sum === 0) return true
  }
  return false
}

type CombinableRow = {
  id: string
  transaktionsdatum: string
  transaktionstext?: string | null
  belopp_skatteverket: number | string
}

/**
 * The groups of 2 to MAX_COMBINED_EVENTS rows of `pool` (open rows of one
 * day) whose amounts together settle a verifikat `canTake` allows, inside
 * combinedMatchWindow, keeping only the unambiguous ones: a group is dropped
 * when another group shares one of its rows or its verifikat. A group with a
 * part netting to zero (hasZeroSumPart) is never a match, so it never
 * competes either.
 */
function unambiguousCombinedMatches<R extends CombinableRow>(
  pool: R[],
  views: EntryView[],
  canTake: (view: EntryView) => boolean,
  account: SkattekontoLedgerAccount,
): Array<{ rows: R[]; view: EntryView }> {
  // A group's window never reaches past the widest window of one of its
  // rows, so the verifikat a group can settle are read off once per pool.
  let from = ''
  let to = ''
  for (const r of pool) {
    const w = combinedMatchWindow(r.transaktionsdatum, [r])
    if (!from || w.from < from) from = w.from
    if (!to || w.to > to) to = w.to
  }
  const reachable = views.filter(v => canTake(v) && v.entry.entry_date >= from && v.entry.entry_date <= to)
  const found: Array<{ rows: R[]; view: EntryView }> = []
  for (const subset of subsets(pool, 2, MAX_COMBINED_EVENTS)) {
    const amounts = subset.map(r => Number(r.belopp_skatteverket))
    if (hasZeroSumPart(amounts)) continue
    const window = combinedMatchWindow(subset[0].transaktionsdatum, subset)
    for (const view of reachable) {
      if (view.entry.entry_date < window.from || view.entry.entry_date > window.to) continue
      if (groupSettlesEntry(view.lines, amounts, account).ok) found.push({ rows: subset, view })
    }
  }
  return found.filter(m => {
    const rowIds = new Set(m.rows.map(r => r.id))
    return !found.some(
      o => o !== m && (o.view.entry.id === m.view.entry.id || o.rows.some(r => rowIds.has(r.id))),
    )
  })
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
 *      others; accepting it links them together or not at all. A second
 *      round then takes each day's remaining rows of BOTH signs (crm#1004:
 *      an inbetalning booked net of the debits it paid, slutlig skatt net of
 *      tillgodoförd preliminärskatt, a beslut netted into its AGI line) and
 *      proposes a group only when it mixes signs, has no part netting to
 *      zero (hasZeroSumPart) and holds no row that settles a verifikat on
 *      its own. Same-sign groups still compete in that round, so a mixed
 *      group never takes a row or verifikat another group also explains.
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
  skattekontoAccount?: SkattekontoLedgerAccount,
): Promise<Map<string, SkattekontoMatchCandidate>> {
  const unmatched = rows.filter(r => !r.journal_entry_id)
  if (unmatched.length === 0) return new Map()
  let account: SkattekontoLedgerAccount
  try {
    account = skattekontoAccount ?? (await resolveSkattekontoAccount(supabase, companyId))
  } catch {
    // Same posture as a failed candidate search: no suggestions.
    return new Map()
  }

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
      filterLines: (q: EntryLinesQuery) => q.eq('account_number', account),
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
      ? await loadCancelledEntryIds(supabase, companyId, from, to, account)
      : new Set()
  } catch {
    // Without the storno check no candidate is safe to propose.
    return new Map()
  }

  const entryViews = buildEntryViews(
    lines,
    (linked ?? []) as Array<{ journal_entry_id: string | null; belopp_skatteverket?: number | string | null }>,
    cancelled,
    account,
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
      const settles = groupSettlesEntry(view.lines, [...view.linked, Number(row.belopp_skatteverket)], account)
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
  // Round one groups each day's rows by sign (crm#128); round two takes each
  // day's remaining rows of both signs and proposes only the mixed groups
  // that pass the stricter rules (crm#1004, see the doc comment above).
  const viewList = Array.from(entryViews.values())
  const canTake = (view: EntryView) => !usedEntries.has(view.entry.id) && view.linked.length === 0
  const amountsOf = (rows: typeof ordered) => rows.map(r => Number(r.belopp_skatteverket))
  // A row with a verifikat of its own is booked separately (or ambiguous):
  // never part of a net line.
  const settlesAlone = (row: (typeof ordered)[number]) => (candidatesByRow.get(row.id) ?? []).length > 0
  for (const mixed of [false, true]) {
    const groups = new Map<string, typeof ordered>()
    for (const row of ordered) {
      if (suggestions.has(row.id)) continue
      const amount = Number(row.belopp_skatteverket)
      if (!amount) continue
      const key = mixed ? row.transaktionsdatum : `${row.transaktionsdatum}|${amount > 0 ? '+' : '-'}`
      const list = groups.get(key) ?? []
      list.push(row)
      groups.set(key, list)
    }
    for (const pool of groups.values()) {
      if (pool.length < 2 || pool.length > MAX_COMBINED_POOL) continue
      // A day of one sign was searched in full by round one.
      if (mixed && !mixesSigns(amountsOf(pool))) continue
      for (const m of unambiguousCombinedMatches(pool, viewList, canTake, account)) {
        if (mixed && (!mixesSigns(amountsOf(m.rows)) || m.rows.some(settlesAlone))) continue
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
 *     open same-day, same-sign rows (combinedMatchWindow; crm#128), or,
 *     when no such group does, together with open same-day rows of both
 *     signs whose net it is, under the mixed-group rules of
 *     findMatchSuggestionsBulk (crm#1004), or, when neither does, together
 *     with open same-sign rows up to 14 days away, in the window a ticked
 *     selection of the same rows gets (groupMatchWindow; crm#1147). The
 *     candidate names those rows in `combined_with` and linking it links
 *     all of them.
 *     A verifikat that already carries links takes such a group only when
 *     the linked rows and the group explain its whole 1630 movement.
 * Cancelled verifikat (storno pairs) are never listed.
 *
 * Returns up to 25 candidates ordered by AGI-period match, then date proximity
 * to the SKV row.
 */
export async function findMatchCandidates(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  account?: SkattekontoLedgerAccount,
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

  const byRow = await findLedgerTwinCandidates(supabase, companyId, [tx], account)
  return { tx, candidates: (byRow.get(tx.id) ?? []).slice(0, 25) }
}

/** Most rows one ticked selection links to one verifikat (linkSkattekontoRows' own cap). */
const MAX_GROUP_EVENTS = 50

type GroupRow = {
  id: string
  transaktionsdatum: string
  transaktionstext: string | null
  belopp_skatteverket: number | string
  journal_entry_id: string | null
  is_ignored: boolean | null
  status: 'booked' | 'upcoming'
}

/**
 * Candidate verifikat for several open rows the user ticked together
 * ("Matcha mot verifikat" in the /skattekonto bulk bar): the entries whose
 * 1630 movement the whole selection settles, together with any rows already
 * linked to the entry (groupSettlesEntry, exact to the öre).
 *
 * The automatic combined candidates stop at groups of MAX_COMBINED_EVENTS
 * rows near each other (same-day, or same-sign rows within 14 days of the
 * row searched); a selection is the user's own, so its rows may have either
 * sign and any dates. The window is groupMatchWindow: from
 * combinedMatchWindow's start for the earliest row (widened to a declaration
 * month every row names) to 14 days after the latest. Cancelled verifikat
 * (storno pairs) are never listed. Linking goes through
 * matchSkattekontoToEntry with the other rows as alsoTransactionIds, which
 * checks the whole group again before the write.
 *
 * Returns up to 25 candidates, nearest the earliest row's date first, then
 * voucher number descending. Throws SkattekontoMatchError for a selection
 * that cannot be linked, and a plain Error when a read fails.
 */
export async function findGroupMatchCandidates(
  supabase: SupabaseClient,
  companyId: string,
  transactionIds: string[],
  skattekontoAccount?: SkattekontoLedgerAccount,
): Promise<{ candidates: SkattekontoMatchCandidate[] }> {
  const ids = [...new Set(transactionIds)]
  if (ids.length < 2 || ids.length > MAX_GROUP_EVENTS) {
    throw new SkattekontoMatchError(
      `Välj mellan 2 och ${MAX_GROUP_EVENTS} händelser.`,
      'INVALID_CANDIDATE',
    )
  }

  const { data, error } = await supabase
    .from('skattekonto_transactions')
    .select('id, transaktionsdatum, transaktionstext, belopp_skatteverket, journal_entry_id, is_ignored, status')
    .eq('company_id', companyId)
    .in('id', ids)
  const rows = (data ?? []) as GroupRow[]
  if (error || rows.length !== ids.length) {
    throw new SkattekontoMatchError(
      'Någon av skattekonto-transaktionerna hittades inte.',
      'TRANSACTION_NOT_FOUND',
    )
  }
  if (rows.some(r => r.journal_entry_id)) {
    throw new SkattekontoMatchError(
      'En av transaktionerna är redan kopplad till ett verifikat.',
      'ALREADY_BOOKED',
    )
  }
  if (rows.some(r => r.is_ignored)) {
    throw new SkattekontoMatchError(
      'En av transaktionerna är ignorerad. Återställ den innan du kopplar.',
      'ROW_IGNORED',
    )
  }
  if (rows.some(r => r.status !== 'booked')) {
    throw new SkattekontoMatchError(
      'En kommande händelse kan inte kopplas ännu.',
      'INVALID_CANDIDATE',
    )
  }

  const belopps = rows.map(r => Number(r.belopp_skatteverket))
  const total = roundOre(belopps.reduce((s, b) => s + b, 0))
  const earliest = rows.map(r => r.transaktionsdatum).sort()[0]
  const { from, to } = groupMatchWindow(rows)
  const account = skattekontoAccount ?? (await resolveSkattekontoAccount(supabase, companyId))

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
      filterLines: (q: EntryLinesQuery) => q.eq('account_number', account),
    })
  } catch (err) {
    throw searchFailed(err)
  }
  if (lines.length === 0) return { candidates: [] }

  // Rows already linked to a candidate entry join the group check. A failed
  // read throws: treating a linked entry as unlinked would offer a link the
  // write then refuses.
  const entryIds = Array.from(new Set(lines.map(l => l.journal_entries.id)))
  const linked: Array<{ journal_entry_id: string | null; belopp_skatteverket?: number | string | null }> = []
  for (let i = 0; i < entryIds.length; i += LINKED_ID_CHUNK) {
    const { data: linkedData, error: linkedError } = await supabase
      .from('skattekonto_transactions')
      .select('journal_entry_id, belopp_skatteverket')
      .eq('company_id', companyId)
      .in('journal_entry_id', entryIds.slice(i, i + LINKED_ID_CHUNK))
    if (linkedError) throw searchFailed(linkedError.message)
    linked.push(...((linkedData ?? []) as typeof linked))
  }

  let cancelled: Set<string>
  try {
    cancelled = await loadCancelledEntryIds(supabase, companyId, from, to, account)
  } catch (err) {
    throw searchFailed(err)
  }

  const candidates: SkattekontoMatchCandidate[] = []
  for (const view of buildEntryViews(lines, linked, cancelled, account).values()) {
    const settles = groupSettlesEntry(view.lines, [...view.linked, ...belopps], account)
    if (!settles.ok) continue
    const e = view.entry
    candidates.push({
      journal_entry_id: e.id,
      voucher_number: e.voucher_number,
      voucher_series: e.voucher_series,
      entry_date: e.entry_date,
      description: e.description,
      status: e.status,
      matched_amount: Math.abs(total),
      matched_side: expectedSide(total),
      ...(settles.via === 'entry_total' ? { matched_via_entry_total: true } : {}),
      ...(view.linked.length > 0 ? { joins_linked_count: view.linked.length } : {}),
    })
  }
  candidates.sort((a, b) => {
    const da = Math.abs(daysBetweenIso(a.entry_date, earliest))
    const db = Math.abs(daysBetweenIso(b.entry_date, earliest))
    if (da !== db) return da - db
    return (b.voucher_number ?? 0) - (a.voucher_number ?? 0)
  })
  return { candidates: candidates.slice(0, 25) }
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
  account?: SkattekontoLedgerAccount,
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
  return findLedgerTwinCandidates(supabase, companyId, (data ?? []) as LedgerTwinProbe[], account)
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

/** Open rows tried together with one searched row: the verifikat dates and amounts the group stands for. */
type CompanionGroup = {
  rows: CompanionRow[]
  window: { from: string; to: string }
  /** The searched row's amount first, then the rows'. */
  amounts: number[]
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
 * already linked, or combined with other open rows of the day or the days
 * around it; storno pairs never count). The window data (1630 entries,
 * links, AGI entries, nearby open rows, storno pairs) is read once per
 * cluster of rows whose windows lie close together
 * (clusterProbesByWindow), so a batch of rows in one month
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
  skattekontoAccount?: SkattekontoLedgerAccount,
): Promise<Map<string, SkattekontoMatchCandidate[]>> {
  const out = new Map<string, SkattekontoMatchCandidate[]>()
  for (const p of probes) out.set(p.id, [])
  if (probes.length === 0) return out
  const account = skattekontoAccount ?? (await resolveSkattekontoAccount(supabase, companyId))

  // One window read per cluster of rows whose windows lie close together,
  // never one read across the whole span of a batch: two rows years apart
  // must not pull every verifikat in between. A row only ever uses entries
  // inside its own window, so every row still sees all its candidates, and
  // an isolated row gets exactly the read the single-row search makes.
  for (const cluster of clusterProbesByWindow(probes)) {
    const found = await searchLedgerTwinWindow(supabase, companyId, cluster, account)
    for (const [id, candidates] of found) out.set(id, candidates)
  }
  return out
}

/**
 * Rows whose windows lie at most this many days apart share one window read:
 * reading a short gap costs less than a second round of queries.
 */
const TWIN_WINDOW_MERGE_GAP_DAYS = 31

/**
 * The entry dates a row's candidates can have. Alone or with rows of its own
 * day: [combined window start, date + 14 days]. Grouped with an open row up
 * to COMPANION_WINDOW_DAYS away (crm#1147) the group's window applies
 * (groupMatchWindow): it starts 14 days before the earlier row and ends 14
 * days after the later one, so the reach is that much wider on both sides.
 */
function probeWindow(p: LedgerTwinProbe): { from: string; to: string } {
  const own = combinedMatchWindow(p.transaktionsdatum, [p]).from
  const grouped = addDays(p.transaktionsdatum, -(COMPANION_WINDOW_DAYS + DATE_WINDOW_DAYS))
  return {
    from: own < grouped ? own : grouped,
    to: addDays(p.transaktionsdatum, COMPANION_WINDOW_DAYS + DATE_WINDOW_DAYS),
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

/**
 * The mixed-sign groups (crm#1004) of the probes' days, by the rules of the
 * proposal pass in findMatchSuggestionsBulk: per day, open rows (and the
 * probes) of both signs whose net settles an unlinked verifikat, with no
 * part netting to zero, no row that settles a verifikat on its own, and no
 * other group of the day competing for its rows or its verifikat. Keyed
 * `${rowId}|${journalEntryId}`; the value is the group's other rows.
 */
function mixedGroupCompanions(
  probes: LedgerTwinProbe[],
  openByDate: ReadonlyMap<string, readonly LedgerTwinProbe[]>,
  views: ReadonlyMap<string, EntryView>,
  account: SkattekontoLedgerAccount,
): Map<string, LedgerTwinProbe[]> {
  const out = new Map<string, LedgerTwinProbe[]>()
  const viewList = Array.from(views.values())
  const amountsOf = (rows: LedgerTwinProbe[]) => rows.map(r => Number(r.belopp_skatteverket))
  // A row with a verifikat of its own (alone, or joining the rows already
  // linked to it) is booked separately: never part of a net line.
  const settlesAlone = (r: LedgerTwinProbe) => {
    const belopp = Number(r.belopp_skatteverket)
    const from = addDays(r.transaktionsdatum, -DATE_WINDOW_DAYS)
    const to = addDays(r.transaktionsdatum, DATE_WINDOW_DAYS)
    return viewList.some(
      v =>
        v.entry.entry_date >= from &&
        v.entry.entry_date <= to &&
        groupSettlesEntry(v.lines, [...v.linked, belopp], account).ok,
    )
  }
  for (const date of new Set(probes.map(p => p.transaktionsdatum))) {
    const byId = new Map<string, LedgerTwinProbe>()
    for (const r of [...(openByDate.get(date) ?? []), ...probes.filter(p => p.transaktionsdatum === date)]) {
      if (Number(r.belopp_skatteverket)) byId.set(r.id, r)
    }
    const pool = Array.from(byId.values())
    if (pool.length < 2 || pool.length > MAX_COMBINED_POOL || !mixesSigns(amountsOf(pool))) continue
    for (const m of unambiguousCombinedMatches(pool, viewList, v => v.linked.length === 0, account)) {
      if (!mixesSigns(amountsOf(m.rows)) || m.rows.some(settlesAlone)) continue
      for (const r of m.rows) out.set(`${r.id}|${m.view.entry.id}`, m.rows.filter(o => o.id !== r.id))
    }
  }
  return out
}

/** findLedgerTwinCandidates for one cluster of probes: one read of their joint window. */
async function searchLedgerTwinWindow(
  supabase: SupabaseClient,
  companyId: string,
  probes: LedgerTwinProbe[],
  account: SkattekontoLedgerAccount,
): Promise<Map<string, SkattekontoMatchCandidate[]>> {
  const out = new Map<string, SkattekontoMatchCandidate[]>()
  for (const p of probes) out.set(p.id, [])

  // Widest window any probe's candidate can use (probeWindow: a combined
  // candidate may reach back to its AGI period start, or follow a companion
  // row of another day); per-row and per-group windows are applied below.
  let from = ''
  let to = ''
  for (const p of probes) {
    const reach = probeWindow(p)
    if (!from || reach.from < from) from = reach.from
    if (!to || reach.to > to) to = reach.to
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
      filterLines: (q: EntryLinesQuery) => q.eq('account_number', account),
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

  // Open rows on the probes' dates and up to COMPANION_WINDOW_DAYS around
  // them: the pool a combined candidate draws from. Read as one range; which
  // rows a probe may use is decided per probe below.
  const probeDates = probes.map(p => p.transaktionsdatum).sort()
  const companionsFrom = addDays(probeDates[0], -COMPANION_WINDOW_DAYS)
  const companionsTo = addDays(probeDates[probeDates.length - 1], COMPANION_WINDOW_DAYS)
  let companionData: CompanionRow[]
  try {
    companionData = await fetchAllRows<CompanionRow>(
      ({ from: rangeFrom, to: rangeTo }) =>
        supabase
          .from('skattekonto_transactions')
          .select('id, transaktionsdatum, transaktionstext, belopp_skatteverket')
          .eq('company_id', companyId)
          .gte('transaktionsdatum', companionsFrom)
          .lte('transaktionsdatum', companionsTo)
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
    cancelled = await loadCancelledEntryIds(supabase, companyId, from, to, account)
  } catch (err) {
    throw searchFailed(err)
  }

  const views = buildEntryViews(typedRows, linked, cancelled, account)
  const mixedCompanions = mixedGroupCompanions(probes, openByDate, views, account)

  for (const p of probes) {
    const belopp = Number(p.belopp_skatteverket)
    const amount = Math.round(Math.abs(belopp) * 100) / 100
    const side = expectedSide(belopp)
    const singleFrom = addDays(p.transaktionsdatum, -DATE_WINDOW_DAYS)
    const singleTo = addDays(p.transaktionsdatum, DATE_WINDOW_DAYS)
    // The widest window any of this row's candidates can use; each kind of
    // candidate applies its own window inside it.
    const reach = probeWindow(p)
    const pKey = periodKeyByProbe.get(p.id)
    const periodEntryIds = pKey ? agiIndex.get(pKey)?.entryIds ?? null : null

    // Open same-day, same-sign rows that may settle a verifikat together
    // with this one: the first MAX_COMBINED_POOL other open same-sign rows of
    // the day (an opposite-sign row joins a group only through the stricter
    // mixed-group search, mixedCompanions, so it must not take a slot here).
    const sameSign = (c: CompanionRow) =>
      c.id !== p.id && belopp !== 0 && Math.sign(Number(c.belopp_skatteverket)) === Math.sign(belopp)
    const companions = (openByDate.get(p.transaktionsdatum) ?? []).filter(sameSign).slice(0, MAX_COMBINED_POOL)
    // A group as the search tries it: its window and amounts are the same
    // for every verifikat, so they are worked out once per row.
    const asGroup = (subset: CompanionRow[]): CompanionGroup => ({
      rows: subset,
      window: groupMatchWindow([p, ...subset]),
      amounts: [belopp, ...subset.map(c => Number(c.belopp_skatteverket))],
    })
    const sameDayGroups = subsets(companions, 1, MAX_COMBINED_EVENTS - 1).map(asGroup)
    // crm#1147: Skatteverket does not always post the events of one
    // verifikat on one day, so open same-sign rows up to
    // COMPANION_WINDOW_DAYS away may join too. The day's own rows keep their
    // slots, then the nearest day first (the earlier one on a tie), in id
    // order within a day, so the pool does not depend on how the rows were
    // read. Only the groups that borrow a row from another day are new here.
    const otherDays: CompanionRow[] = []
    for (let offset = 1; offset <= COMPANION_WINDOW_DAYS; offset++) {
      for (const date of [addDays(p.transaktionsdatum, -offset), addDays(p.transaktionsdatum, offset)]) {
        otherDays.push(
          ...(openByDate.get(date) ?? []).filter(sameSign).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        )
      }
    }
    const widePool = [...companions, ...otherDays].slice(0, MAX_COMBINED_POOL)
    const crossDateGroups =
      widePool.length > companions.length
        ? subsets(widePool, 1, MAX_COMBINED_EVENTS - 1)
            .filter(subset => subset.some(c => c.transaktionsdatum !== p.transaktionsdatum))
            .map(asGroup)
        : []

    const candidates: SkattekontoMatchCandidate[] = []
    for (const view of views.values()) {
      const e = view.entry
      // A batch reads one window for all rows; skip what this row cannot reach.
      if (e.entry_date < reach.from || e.entry_date > reach.to) continue
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
        const settles = groupSettlesEntry(view.lines, [...view.linked, belopp], account)
        if (settles.ok) {
          candidates.push({
            ...base,
            ...(settles.via === 'entry_total' ? { matched_via_entry_total: true } : {}),
            ...(view.linked.length > 0 ? { joins_linked_count: view.linked.length } : {}),
          })
          continue
        }
      }
      // Does this row settle the verifikat together with the group, inside
      // the group's window? An unlinked verifikat by the plain group rule. A
      // verifikat that already carries links (crm#1147: the payment row of a
      // voucher that also books the debitering it paid) only when the linked
      // rows and the group explain its WHOLE 1630 movement. The sum rule
      // alone is not enough there: with fixed salaries, last month's fully
      // linked voucher plus this month's identical rows also sum to one of
      // its lines, and that voucher has nothing left for them.
      const groupSettles = (g: CompanionGroup): boolean => {
        if (e.entry_date < g.window.from || e.entry_date > g.window.to) return false
        if (view.linked.length === 0) return groupSettlesEntry(view.lines, g.amounts, account).ok
        const joined = evaluateSkattekontoLink(view.lines, view.linked, g.amounts, { account })
        return joined.ok && joined.remainder === 0
      }
      // Smallest same-sign group of the day first, else the day's mixed-sign
      // group (crm#1004, unlinked verifikat only), else the smallest group
      // that borrows a row from another day; one proposal per verifikat.
      const group: LedgerTwinProbe[] | undefined =
        sameDayGroups.find(groupSettles)?.rows ??
        mixedCompanions.get(`${p.id}|${e.id}`) ??
        crossDateGroups.find(groupSettles)?.rows
      if (!group) continue
      const amounts = [belopp, ...group.map(c => Number(c.belopp_skatteverket))]
      candidates.push({
        ...base,
        combined_with: group.map(c => ({
          id: c.id,
          transaktionsdatum: c.transaktionsdatum,
          transaktionstext: c.transaktionstext ?? '',
          belopp_skatteverket: Number(c.belopp_skatteverket),
        })),
        combined_total: Math.abs(roundOre(amounts.reduce((s, a) => s + a, 0))),
        ...(view.linked.length > 0 ? { joins_linked_count: view.linked.length } : {}),
      })
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
  skattekontoAccount?: SkattekontoLedgerAccount,
): Promise<void> {
  const others = [...new Set(alsoTransactionIds)].filter(id => id !== transactionId)
  if (others.length > 0) {
    try {
      await linkSkattekontoRows(supabase, companyId, [transactionId, ...others], journalEntryId, {
        account: skattekontoAccount,
      })
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
  const account = skattekontoAccount ?? (await resolveSkattekontoAccount(supabase, companyId))
  const settles = groupSettlesEntry(
    entry.lines as Line[] | null,
    [...linkedRows.map(r => Number(r.belopp_skatteverket)), Number(tx.belopp_skatteverket)],
    account,
  )
  if (!settles.ok) {
    if (linkedRows.length > 0) {
      throw new SkattekontoMatchError(
        'Verifikatet är redan kopplat till en annan skattekonto-transaktion.',
        'ENTRY_ALREADY_LINKED',
      )
    }
    throw new SkattekontoMatchError(
      `Verifikatet saknar en matchande rad på ${account}.`,
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
