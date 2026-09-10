import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { dbError } from '@/lib/errors/db-error'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { getOpeningBalances } from './opening-balances'
import type { TrialBalanceRow } from '@/types'

/**
 * Generate trial balance (Saldobalans) for a fiscal period or a date range
 * inside one.
 *
 * Computes IB (ingående balans), period movements, and UB (utgående balans)
 * per BFNAR 2013:2 requirements. Uses the opening_balance_entry set by
 * year-end closing when available; falls back to summing prior-period entries.
 *
 * When `fromDate`/`toDate` are passed, they must lie inside the fiscal
 * period. The function rolls the IB forward from `period_start` to
 * `fromDate − 1` (so "opening" reflects the state at `fromDate`) and limits
 * period activity to `[fromDate, toDate]`. Defaults equal `period_start` and
 * `period_end`: identical to the no-options behaviour.
 *
 * When `dimensions` is passed (map of SIE dim number → object code, e.g.
 * `{"6":"P001"}`, AND across keys), both line queries filter with jsonb
 * containment (`dimensions @> …`, served by idx_jel_dimensions_gin). The
 * result is then a PARTIAL view: opening balances from year-end closing are
 * company-wide, so callers must only use the filter for P&L-style reports
 * (classes 3-8) where IB is immaterial: never for balance/statutory reports.
 * The catalog whitelist + statutory-guard test pin this.
 *
 * Period activity is summed per account by the get_trial_balance_aggregates
 * RPC (migration 20260910160147, issue #2470): one round trip returns the
 * 'period' bucket and, for a sub-range, the 'rollforward' bucket, under the
 * requested ClosingEntryMode. The previous implementation walked every line
 * of the period through the shared two-step entry-lines fetch
 * (lib/bookkeeping/entry-lines.ts) in 100-entry chunks and summed in JS; it
 * is kept behind REPORTS_TB_RPC=off as the rollback for one release and is
 * removed together with the flag in the follow-up.
 */
/**
 * How a caller treats the year-end closing entries. Required, with no default,
 * on purpose: picking wrong is silent and produces a plausible-looking report,
 * so every call site must state its choice and be reviewable.
 *
 * A resultatavslut posts the mirror image of every P&L account into 2099 inside
 * the same fiscal period. A caller that sums class 3-8 and forgets to exclude
 * it therefore reads ZERO across the board, and the balance sheet still ties
 * out, so nothing warns. That defect shipped three times (årsredovisning
 * 2026-07-23, INK2R and NE-bilaga 2026-07-29, Resultatrapport found in the
 * same sweep) before this parameter existed.
 */
export type ClosingEntryMode =
  /**
   * Every entry, resultatavslut included. Correct for balance sheets (2099
   * must carry årets resultat), for the year-end engine itself, and for
   * archives and diagnostics that must see the ledger as posted.
   */
  | 'include'
  /**
   * Drop only fiscal_periods.closing_entry_id. Correct for statutory annual
   * reports: skatt, avskrivningar and bokslutsdispositioner also carry
   * source_type 'year_end' and belong on the form.
   */
  | 'exclude-final'
  /**
   * Drop every source_type 'year_end' entry and its storno/correction chain.
   * The operational-report convention: pre-bokslut activity only.
   */
  | 'exclude-all-year-end'

/**
 * Kill switch for the SQL aggregation (issue #2470). Unset or any value other
 * than 'off' selects the get_trial_balance_aggregates RPC; 'off' restores the
 * chunked entry-lines walk. Read per call so a test can pin either path.
 */
function aggregatesRpcEnabled(): boolean {
  return process.env.REPORTS_TB_RPC !== 'off'
}

type AccountSums = Map<string, { debit: number; credit: number }>

/** Additive fold with the Number()||0 coercion the line loops always used. */
function addActivity(target: AccountSums, accountNumber: string, debit: unknown, credit: unknown): void {
  const existing = target.get(accountNumber) || { debit: 0, credit: 0 }
  existing.debit += Number(debit) || 0
  existing.credit += Number(credit) || 0
  target.set(accountNumber, existing)
}

interface PeriodActivity {
  /** Activity in [period_start, fromDate): folded into IB by the caller. */
  rollforward: AccountSums
  /** Activity in [fromDate, toDate] (the whole period by default). */
  period: AccountSums
}

interface ActivityScope {
  supabase: SupabaseClient
  companyId: string
  fiscalPeriodId: string
  closingEntry: ClosingEntryMode
  fromDate?: string
  toDate?: string
  /** The opening-balance entry, excluded from activity (already in IB). */
  obEntryId: string | null
  dimensionFilter?: Record<string, string>
}

/**
 * One round trip: the RPC applies the closing mode, the OB exclusion, the
 * date buckets and the dimension containment in SQL and returns per-account
 * sums. The fail-closed guard for 'exclude-final' lives both here (before
 * any journal read) and in the RPC.
 */
async function fetchActivityViaRpc(scope: ActivityScope): Promise<PeriodActivity> {
  const { data, error } = await scope.supabase.rpc('get_trial_balance_aggregates', {
    p_company_id: scope.companyId,
    p_fiscal_period_id: scope.fiscalPeriodId,
    p_closing_mode: scope.closingEntry,
    p_from_date: scope.fromDate ?? null,
    p_to_date: scope.toDate ?? null,
    p_exclude_entry_id: scope.obEntryId,
    p_dimensions: scope.dimensionFilter ?? null,
  })
  // dbError keeps the SQLSTATE so a statement timeout still classifies as
  // transient downstream (see lib/supabase/fetch-all.ts for the history).
  if (error) {
    throw dbError(error, 'get_trial_balance_aggregates failed')
  }

  // One jsonb array (no PostgREST max-rows cap; see the migration).
  const activity: PeriodActivity = { rollforward: new Map(), period: new Map() }
  for (const raw of (Array.isArray(data) ? data : []) as unknown[]) {
    const row = raw as {
      bucket?: unknown
      account_number?: unknown
      debit?: unknown
      credit?: unknown
    }
    const target =
      row.bucket === 'rollforward'
        ? activity.rollforward
        : row.bucket === 'period'
          ? activity.period
          : null
    if (!target) continue
    addActivity(target, String(row.account_number ?? ''), row.debit, row.credit)
  }
  return activity
}

/**
 * The pre-#2470 implementation, verbatim: the shared two-step entry-lines
 * fetch (entries first, then lines chunked by entry id, both paginated),
 * once for the roll-forward slice and once for the period, summed in JS.
 * Selected by REPORTS_TB_RPC=off only; deleted with the flag.
 */
async function fetchActivityViaEntryLines(
  scope: ActivityScope,
  period: { period_start: string; closing_entry_id: string | null } | null,
  yearEndEntryIds: string[],
): Promise<PeriodActivity> {
  const { supabase, companyId, fiscalPeriodId, obEntryId, dimensionFilter } = scope
  const excludeAllYearEndEntries = scope.closingEntry === 'exclude-all-year-end'
  const excludeFinalOnly = scope.closingEntry === 'exclude-final'

  const excludeYearEndChain = (query: EntryLinesQuery): EntryLinesQuery => {
    let q = query.neq('source_type', 'year_end')
    if (yearEndEntryIds.length > 0) {
      const idList = `(${yearEndEntryIds.join(',')})`
      q = q.or(`reverses_id.is.null,reverses_id.not.in.${idList}`)
      q = q.or(`correction_of_id.is.null,correction_of_id.not.in.${idList}`)
    }
    return q
  }

  const closingEntryId = excludeFinalOnly
    ? period?.closing_entry_id ?? null
    : null
  // The base query already admits only posted and reversed entries. Exclude a
  // posted final closing entry, but retain a reversed one together with its
  // storno so the two continue to net to zero. Draft entries never enter the
  // base query.
  const excludeClosingEntry = (query: EntryLinesQuery): EntryLinesQuery =>
    closingEntryId
      ? query.or(`id.neq.${closingEntryId},status.neq.posted`)
      : query

  // When the caller requests a sub-range starting after period_start, the
  // "opening" of that window must include all activity since the period
  // started (rolled forward below).
  const rollForwardWindow =
    scope.fromDate && period?.period_start && scope.fromDate > period.period_start
      ? { periodStart: period.period_start, fromDate: scope.fromDate }
      : null

  type Line = {
    id: string
    account_number: string
    debit_amount: number
    credit_amount: number
  }

  // The array order [roll-forward, lines] keeps each table's queries in the
  // same order the sequential version issued them.
  const [priorLines, lines] = await Promise.all([
    // ── Roll IB forward from period_start up to fromDate ───────────
    rollForwardWindow
      ? fetchEntryLines<Line>({
          supabase,
          lineColumns: 'id, account_number, debit_amount, credit_amount',
          filterEntries: (q: EntryLinesQuery) => {
            let query = q
              .eq('company_id', companyId)
              .eq('fiscal_period_id', fiscalPeriodId)
              .in('status', ['posted', 'reversed'])
              .gte('entry_date', rollForwardWindow.periodStart)
              .lt('entry_date', rollForwardWindow.fromDate)

            if (obEntryId) {
              query = query.neq('id', obEntryId)
            }

            if (excludeAllYearEndEntries) {
              query = excludeYearEndChain(query)
            }
            if (excludeFinalOnly) {
              query = excludeClosingEntry(query)
            }

            return query
          },
          filterLines: dimensionFilter
            ? // jsonb containment (@>): served by idx_jel_dimensions_gin.
              (q: EntryLinesQuery) => q.contains('dimensions', dimensionFilter)
            : undefined,
        })
      : Promise.resolve([] as Line[]),
    // ── Period lines (excluding opening balance entry) ─────────────
    // If year-end closing set an OB entry, exclude it from period lines so
    // its values aren't double-counted (they're already captured as IB).
    // Race condition note: if year-end closing runs concurrently and sets
    // obEntryId between the period query and this query, the OB entry could
    // be missed from both IB and period. The window is sub-second and the
    // consequence is a single stale report: acceptable.
    fetchEntryLines<Line>({
      supabase,
      lineColumns: 'id, account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) => {
        let query = q
          .eq('company_id', companyId)
          .eq('fiscal_period_id', fiscalPeriodId)
          .in('status', ['posted', 'reversed'])

        // Date filters are only applied when the caller explicitly asks. The
        // period itself is already enforced via fiscal_period_id, so adding
        // redundant entry_date bounds for the default case would just
        // increase query complexity (and break older mocks that don't stub gte
        // /lte). The fiscal_period_id constraint plus a CHECK on entry_date in
        // the engine keep activity inside the period.
        if (scope.fromDate) {
          query = query.gte('entry_date', scope.fromDate)
        }
        if (scope.toDate) {
          query = query.lte('entry_date', scope.toDate)
        }

        if (obEntryId) {
          query = query.neq('id', obEntryId)
        }

        if (excludeAllYearEndEntries) {
          query = excludeYearEndChain(query)
        }
        if (excludeFinalOnly) {
          query = excludeClosingEntry(query)
        }

        return query
      },
      filterLines: dimensionFilter
        ? // jsonb containment (@>): served by idx_jel_dimensions_gin.
          (q: EntryLinesQuery) => q.contains('dimensions', dimensionFilter)
        : undefined,
    }),
  ])

  const activity: PeriodActivity = { rollforward: new Map(), period: new Map() }
  for (const line of priorLines) {
    addActivity(activity.rollforward, line.account_number, line.debit_amount, line.credit_amount)
  }
  for (const line of lines) {
    addActivity(activity.period, line.account_number, line.debit_amount, line.credit_amount)
  }
  return activity
}

export async function generateTrialBalance(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: {
    closingEntry: ClosingEntryMode
    fromDate?: string
    toDate?: string
    dimensions?: Record<string, string>
  }
): Promise<{
  rows: TrialBalanceRow[]
  totalDebit: number
  totalCredit: number
  isBalanced: boolean
}> {

  const dimensionFilter =
    options.dimensions && Object.keys(options.dimensions).length > 0
      ? options.dimensions
      : undefined
  const excludeAllYearEndEntries = options.closingEntry === 'exclude-all-year-end'
  const excludeFinalOnly = options.closingEntry === 'exclude-final'
  const viaRpc = aggregatesRpcEnabled()

  // Wave 1: the period row (for opening balance computation), the reversed
  // year-end entry ids (legacy path only, and only for
  // 'exclude-all-year-end': the RPC resolves that set in SQL), and the chart
  // of accounts are mutually independent, so they share one parallel round
  // trip instead of three sequential ones. The accounts list is also fetched
  // for reports that turn out empty or fail the closed-period guard below;
  // that occasional extra read-only query is the price of a short critical
  // path, and the returned data is unchanged.
  const [periodResult, yearEndIdRows, accounts] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end, opening_balance_entry_id, closing_entry_id, is_closed, closed_externally')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    !viaRpc && excludeAllYearEndEntries
      ? fetchAllRows<{ id: string }>(({ from, to }) =>
          supabase
            .from('journal_entries')
            .select('id')
            .eq('company_id', companyId)
            .eq('source_type', 'year_end')
            .eq('status', 'reversed')
            .order('id', { ascending: true })
            .range(from, to)
        )
      : Promise.resolve([] as Array<{ id: string }>),
    // Account names for row labelling.
    fetchAllRows<{
      account_number: string
      account_name: string
      account_class: number
    }>(({ from, to }) =>
      supabase
        .from('chart_of_accounts')
        .select('account_number, account_name, account_class')
        .eq('company_id', companyId)
        .order('account_number', { ascending: true })
        .range(from, to)
    ),
  ])
  const { data: period } = periodResult

  // Existing operational reports intentionally exclude every year_end entry.
  // Statutory annual reports must exclude only the linked final closing entry:
  // tax, depreciation, and appropriations also use source_type year_end. A
  // closed period without the link is ambiguous, so fail instead of silently
  // understating the statutory report. A period klarmarkerad as closed in a
  // previous system (closed_externally) is the one unambiguous case: its
  // closing verifikat never existed in these books, so there is nothing to
  // strip and the balances as booked are the pre-closing balances. The RPC
  // repeats this guard; it stays here so no journal read is issued at all.
  if (
    excludeFinalOnly
    && period?.is_closed === true
    && !period.closing_entry_id
    && period.closed_externally !== true
  ) {
    throw new Error(
      'Closed fiscal period is missing closing_entry_id; statutory pre-closing balances cannot be generated safely',
    )
  }

  // getOpeningBalances always reports the period's opening_balance_entry_id
  // back as obEntryId (see lib/reports/opening-balances.ts), so the id is
  // known before that fetch resolves and the activity read below can run in
  // the same round trip as the opening-balance read.
  const obEntryId = period?.opening_balance_entry_id ?? null

  const scope: ActivityScope = {
    supabase,
    companyId,
    fiscalPeriodId,
    closingEntry: options.closingEntry,
    fromDate: options.fromDate,
    toDate: options.toDate,
    obEntryId,
    dimensionFilter,
  }

  // Wave 2: opening balances (IB) at period_start and the period activity
  // (roll-forward slice + period sums) are independent reads.
  const [obResult, activity] = await Promise.all([
    getOpeningBalances(supabase, companyId, period),
    viaRpc
      ? fetchActivityViaRpc(scope)
      : fetchActivityViaEntryLines(
          scope,
          period,
          yearEndIdRows.map((r) => r.id),
        ),
  ])

  // A dimension-filtered view cannot use company-wide opening balances (the
  // OB entry and the prior-period RPC are not dimension-aware). Drop them so
  // every reported amount is dimension-scoped activity: correct for the P&L
  // reports the filter is whitelisted for, and never fabricates balances if
  // misapplied. obEntryId is still needed to exclude the OB entry from lines.
  const openingBalances = dimensionFilter
    ? new Map<string, { debit: number; credit: number }>()
    : obResult.balances

  // Additively fold the roll-forward activity into openingBalances so the
  // downstream IB/period split stays correct without changing call sites.
  for (const [accountNumber, sums] of activity.rollforward) {
    addActivity(openingBalances, accountNumber, sums.debit, sums.credit)
  }

  const periodBalances = activity.period

  if (periodBalances.size === 0 && openingBalances.size === 0) {
    return { rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true }
  }

  const accountMap = new Map<string, { name: string; class: number }>()
  for (const acc of accounts) {
    accountMap.set(acc.account_number, {
      name: acc.account_name,
      class: acc.account_class,
    })
  }

  // Merge account numbers from both opening and period
  const allAccountNumbers = new Set([...openingBalances.keys(), ...periodBalances.keys()])

  // Build rows: IB + period = UB
  const rows: TrialBalanceRow[] = []
  for (const accountNumber of allAccountNumbers) {
    const opening = openingBalances.get(accountNumber) || { debit: 0, credit: 0 }
    const periodActivity = periodBalances.get(accountNumber) || { debit: 0, credit: 0 }
    const accountInfo = accountMap.get(accountNumber) || {
      name: `Konto ${accountNumber}`,
      class: parseInt(accountNumber[0]) || 0,
    }

    rows.push({
      account_number: accountNumber,
      account_name: accountInfo.name,
      account_class: accountInfo.class,
      opening_debit: Math.round(opening.debit * 100) / 100,
      opening_credit: Math.round(opening.credit * 100) / 100,
      period_debit: Math.round(periodActivity.debit * 100) / 100,
      period_credit: Math.round(periodActivity.credit * 100) / 100,
      closing_debit: Math.round((opening.debit + periodActivity.debit) * 100) / 100,
      closing_credit: Math.round((opening.credit + periodActivity.credit) * 100) / 100,
    })
  }

  rows.sort((a, b) => a.account_number.localeCompare(b.account_number))

  const totalDebit = Math.round(rows.reduce((sum, r) => sum + r.closing_debit, 0) * 100) / 100
  const totalCredit = Math.round(rows.reduce((sum, r) => sum + r.closing_credit, 0) * 100) / 100

  return {
    rows,
    totalDebit,
    totalCredit,
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
  }
}
