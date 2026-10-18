import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { dbError } from '@/lib/errors/db-error'
import { roundOre } from '@/lib/money'
import type { EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
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
 * RPC (migration 20260910163731, issue #2470): one round trip returns the
 * 'period' bucket and, for a sub-range, the 'rollforward' bucket, under the
 * requested ClosingEntryMode.
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
   * Drop only the entries that moved the year's result into equity, as
   * resolved by the result_closing_entry_ids SQL function: the linked
   * fiscal_periods.closing_entry_id plus any resultatavslut booked in a
   * previous system or by hand (last day, result accounts against
   * 2099/2019/2069 only). Correct for statutory annual reports: skatt,
   * avskrivningar and bokslutsdispositioner also carry source_type
   * 'year_end' and belong on the form.
   */
  | 'exclude-final'
  /**
   * Drop every source_type 'year_end' entry and its storno/correction chain.
   * The operational-report convention: pre-bokslut activity only.
   */
  | 'exclude-all-year-end'

/** Debit and credit per account number. */
export type AccountSums = Map<string, { debit: number; credit: number }>

/** Additive fold with the Number()||0 coercion the line loops always used. */
export function addActivity(target: AccountSums, accountNumber: string, debit: unknown, credit: unknown): void {
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
 * The company's reversed year_end entries: the roots whose storno and
 * correction chain 'exclude-all-year-end' drops with them. Company-wide on
 * purpose, like the RPC's ye_reversed: a storno in this period can reverse a
 * year-end entry of another period.
 */
export async function fetchReversedYearEndEntryIds(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string[]> {
  const rows = await fetchAllRows<{ id: string }>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .eq('source_type', 'year_end')
      .eq('status', 'reversed')
      .order('id', { ascending: true })
      .range(from, to)
  )
  return rows.map((r) => r.id)
}

/**
 * 'exclude-all-year-end' as filters on a journal_entries query: every
 * source_type 'year_end' entry, and every entry that reverses or corrects
 * one of `reversedYearEndIds` (fetchReversedYearEndEntryIds). It is the JS
 * twin of the RPC's 'exclude-all-year-end' branch (get_trial_balance_
 * aggregates, migration 20260924202408). The dimension P&L's tagged-line
 * pass (dimension-pnl.ts) and the SIE export's exclude_year_end_closing
 * (sie-export.ts) apply it from here, so the rule has exactly two
 * definitions, this one and the RPC's, and they change together.
 */
export function excludeYearEndChain(
  query: EntryLinesQuery,
  reversedYearEndIds: readonly string[],
): EntryLinesQuery {
  let q = query.neq('source_type', 'year_end')
  if (reversedYearEndIds.length > 0) {
    const idList = `(${reversedYearEndIds.join(',')})`
    q = q.or(`reverses_id.is.null,reverses_id.not.in.${idList}`)
    q = q.or(`correction_of_id.is.null,correction_of_id.not.in.${idList}`)
  }
  return q
}

/** The chart columns a trial balance labels its rows with. */
export interface TrialBalanceChartAccount {
  account_number: string
  account_name: string
  account_class: number
}

/**
 * The company's chart as generateTrialBalance reads it for row labels. A
 * report that builds several trial balances reads it once with this and
 * passes it as `chart` (the read itself, still in flight, is fine), instead
 * of every balance reading the whole chart again.
 */
export function fetchTrialBalanceChart(
  supabase: SupabaseClient,
  companyId: string,
): Promise<TrialBalanceChartAccount[]> {
  return fetchAllRows<TrialBalanceChartAccount>(({ from, to }) =>
    supabase
      .from('chart_of_accounts')
      .select('account_number, account_name, account_class')
      .eq('company_id', companyId)
      .order('account_number', { ascending: true })
      .range(from, to)
  )
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
    /**
     * The company's chart, already read (fetchTrialBalanceChart). Omitted,
     * the balance reads it itself. Only labels the rows: the amounts never
     * depend on it.
     */
    chart?: ReadonlyArray<TrialBalanceChartAccount> | Promise<ReadonlyArray<TrialBalanceChartAccount>>
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
  const excludeFinalOnly = options.closingEntry === 'exclude-final'

  // Wave 1: the period row (for opening balance computation) and the chart
  // of accounts are independent, so they share one parallel round trip. The
  // accounts list is also fetched for reports that turn out empty or fail
  // the closed-period guard below; that occasional extra read-only query is
  // the price of a short critical path, and the returned data is unchanged.
  // A caller that passes the chart skips the read.
  const [periodResult, accounts] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end, opening_balance_entry_id, closing_entry_id, is_closed, closed_externally')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    // Account names for row labelling.
    options.chart ?? fetchTrialBalanceChart(supabase, companyId),
  ])
  const { data: period } = periodResult

  // Existing operational reports intentionally exclude every year_end entry.
  // Statutory annual reports must exclude only the result transfer into
  // equity: tax, depreciation, and appropriations also use source_type
  // year_end. A closed period without the link is ambiguous, so fail instead
  // of silently understating the statutory report. A period klarmarkerad as
  // closed in a previous system (closed_externally) is exempt: its
  // resultatavslut, when the imported file carried one, is recognised by
  // shape in result_closing_entry_ids. The RPC repeats this guard; it stays
  // here so no journal read is issued at all.
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
    getOpeningBalances(supabase, companyId, period, { dimensions: dimensionFilter }),
    fetchActivityViaRpc(scope),
  ])

  // Under a dimension filter the IB is scoped to it as well (issue #3313):
  // the IB entry's lines tagged with the object, or the prior-history
  // fallback with the same containment. A project's balance-sheet accounts
  // open at the project's IB; a filter on a dimension that resets annually
  // opens at zero (getOpeningBalances reads the registry flag). Result accounts never carry IB, so the P&L
  // reports built on this are unchanged. obEntryId still excludes the IB
  // entry from the activity lines.
  const openingBalances = obResult.balances

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

  const rows = buildTrialBalanceRows(openingBalances, periodBalances, accountMap)

  const totalDebit = roundOre(rows.reduce((sum, r) => sum + r.closing_debit, 0))
  const totalCredit = roundOre(rows.reduce((sum, r) => sum + r.closing_credit, 0))

  return {
    rows,
    totalDebit,
    totalCredit,
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
  }
}

/**
 * The closing balance (UB, debit minus credit) of a set of accounts at the end
 * of a fiscal period, read exactly as the balance sheet reads it: the trial
 * balance with every entry included, so the ingående balans is in it however
 * the year got one (a linked IB verifikat, kept out of the period activity so
 * it counts once, or earlier years' verifikat carried forward). A control that
 * compares an account with its underlag reads the account here instead of
 * summing the year's lines itself, which left out an IB carried forward
 * (crm#1296). Accounts without IB or activity contribute 0.
 */
export async function closingBalanceOf(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  accountNumbers: readonly string[],
): Promise<number> {
  const wanted = new Set(accountNumbers)
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    closingEntry: 'include',
    // The chart only labels rows; the amounts never depend on it.
    chart: [],
  })
  let balance = 0
  for (const row of rows) {
    if (wanted.has(row.account_number)) balance += row.closing_debit - row.closing_credit
  }
  return roundOre(balance)
}

/**
 * The trial balance rows from per-account IB and period activity: the merged
 * account set, `Konto <n>` and the first digit as class for an account missing
 * from the chart, öre rounding on all six amounts (IB + period = UB), sorted
 * by account number. The one row builder: generateTrialBalance and the KPI
 * reports (kpi-aggregates.ts), which sum the same activity in SQL, both build
 * their rows here.
 */
export function buildTrialBalanceRows(
  openingBalances: AccountSums,
  periodBalances: AccountSums,
  accountMap: ReadonlyMap<string, { name: string; class: number }>,
): TrialBalanceRow[] {
  const allAccountNumbers = new Set([...openingBalances.keys(), ...periodBalances.keys()])

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
      opening_debit: roundOre(opening.debit),
      opening_credit: roundOre(opening.credit),
      period_debit: roundOre(periodActivity.debit),
      period_credit: roundOre(periodActivity.credit),
      closing_debit: roundOre(opening.debit + periodActivity.debit),
      closing_credit: roundOre(opening.credit + periodActivity.credit),
    })
  }

  rows.sort((a, b) => a.account_number.localeCompare(b.account_number))
  return rows
}
