import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
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
 * Uses the shared two-step entry-lines fetch (lib/bookkeeping/entry-lines.ts):
 * entries first, then lines chunked by entry id, both paginated, so any
 * number of entries is handled without the pathological journal_entries!inner
 * embed plan (see entry-lines.ts for the full story).
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

  // Wave 1: the period row (for opening balance computation), the reversed
  // year-end entry ids (only needed for 'exclude-all-year-end'), and the
  // chart of accounts are mutually independent, so they share one parallel
  // round trip instead of three sequential ones. The accounts list is now
  // also fetched for reports that turn out empty or fail the closed-period
  // guard below; that occasional extra read-only query is the price of a
  // short critical path, and the returned data is unchanged.
  const [periodResult, yearEndIdRows, accounts] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end, opening_balance_entry_id, closing_entry_id, is_closed, closed_externally')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    excludeAllYearEndEntries
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
  // strip and the balances as booked are the pre-closing balances.
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
  const yearEndEntryIds: string[] = yearEndIdRows.map((r) => r.id)
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

  // getOpeningBalances always reports the period's opening_balance_entry_id
  // back as obEntryId (see lib/reports/opening-balances.ts), so the id is
  // known before that fetch resolves and the line queries below can run in
  // the same round trip as the opening-balance read.
  const obEntryId = period?.opening_balance_entry_id ?? null

  // When the caller requests a sub-range starting after period_start, the
  // "opening" of that window must include all activity since the period
  // started (rolled forward below).
  const rollForwardWindow =
    options.fromDate && period?.period_start && options.fromDate > period.period_start
      ? { periodStart: period.period_start, fromDate: options.fromDate }
      : null

  // Wave 2: opening balances (IB) at period_start, the IB roll-forward
  // slice, and the period lines are independent reads. The array order
  // [OB, roll-forward, lines] keeps each table's queries in the same order
  // the sequential version issued them.
  const [obResult, priorLines, lines] = await Promise.all([
    // ── Opening balances (IB) at period_start ──────────────────────
    getOpeningBalances(supabase, companyId, period),
    // ── Roll IB forward from period_start up to fromDate ───────────
    rollForwardWindow
      ? fetchEntryLines<{
          id: string
          account_number: string
          debit_amount: number
          credit_amount: number
        }>({
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
      : Promise.resolve(
          [] as Array<{
            id: string
            account_number: string
            debit_amount: number
            credit_amount: number
          }>
        ),
    // ── Period lines (excluding opening balance entry) ─────────────
    // If year-end closing set an OB entry, exclude it from period lines so
    // its values aren't double-counted (they're already captured as IB).
    // Race condition note: if year-end closing runs concurrently and sets
    // obEntryId between the period query and this query, the OB entry could
    // be missed from both IB and period. The window is sub-second and the
    // consequence is a single stale report: acceptable.
    fetchEntryLines<{
      id: string
      account_number: string
      debit_amount: number
      credit_amount: number
    }>({
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
        if (options.fromDate) {
          query = query.gte('entry_date', options.fromDate)
        }
        if (options.toDate) {
          query = query.lte('entry_date', options.toDate)
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

  // A dimension-filtered view cannot use company-wide opening balances (the
  // OB entry and the prior-period RPC are not dimension-aware). Drop them so
  // every reported amount is dimension-scoped activity: correct for the P&L
  // reports the filter is whitelisted for, and never fabricates balances if
  // misapplied. obEntryId is still needed to exclude the OB entry from lines.
  const openingBalances = dimensionFilter
    ? new Map<string, { debit: number; credit: number }>()
    : obResult.balances

  // Additively fold the roll-forward lines into openingBalances so the
  // downstream IB/period split stays correct without changing call sites.
  for (const line of priorLines) {
    const existing = openingBalances.get(line.account_number) || { debit: 0, credit: 0 }
    existing.debit += Number(line.debit_amount) || 0
    existing.credit += Number(line.credit_amount) || 0
    openingBalances.set(line.account_number, existing)
  }

  if (lines.length === 0 && openingBalances.size === 0) {
    return { rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true }
  }

  const accountMap = new Map<string, { name: string; class: number }>()
  for (const acc of accounts) {
    accountMap.set(acc.account_number, {
      name: acc.account_name,
      class: acc.account_class,
    })
  }

  // Aggregate period activity by account
  const periodBalances = new Map<string, { debit: number; credit: number }>()

  for (const line of lines) {
    const existing = periodBalances.get(line.account_number) || { debit: 0, credit: 0 }
    existing.debit += Number(line.debit_amount) || 0
    existing.credit += Number(line.credit_amount) || 0
    periodBalances.set(line.account_number, existing)
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
