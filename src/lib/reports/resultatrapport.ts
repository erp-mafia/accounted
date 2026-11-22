import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { getLatestPostedVouchers } from './latest-vouchers'
import { resolvePreviousFiscalPeriod } from '@/lib/core/bookkeeping/period-service'
import type {
  BudgetComparison,
  LatestVoucherPerSeries,
  ResultatrapportReport,
  ResultatrapportRow,
  ResultatrapportGroup,
  TrialBalanceRow,
} from '@/types'
import { roundOre } from '@/lib/money'
import { loadReportBudget, type LoadedReportBudget } from '@/lib/budgets/report-budget'
import { figures } from '@/lib/budgets/budget-vs-actual'
import { RESULT_CLASS_LABELS as CLASS_LABELS } from './result-class-labels'

/**
 * Resultatrapport: operational P&L report.
 *
 * Lists every account in classes 3-8 with current-period and prior-period
 * values side by side. Unlike Resultaträkning (formal, ÅRL Bilaga 2), this
 * keeps account numbers and is meant for ongoing reconciliation, not for
 * årsbokslut/årsredovisning.
 *
 * Account 8999 is listed like any other class-8 account (#2455). It only
 * carries a balance when the user books or imports the omföring of årets
 * resultat by hand (our own bokslut verifikat zeroes each P&L account straight
 * against 2099 and never touches 8999). Listing it makes "Beräknat resultat"
 * read zero after that omföring, the Fortnox/Visma resultatrapport
 * convention, and keeps this report in agreement with huvudboken. The formal
 * Resultaträkning (generateIncomeStatement) still excludes 8999: ÅRL's
 * uppställningsform has no such line, årets resultat is always computed there.
 */
export async function generateResultatrapport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: {
    fromDate?: string
    toDate?: string
    /** SIE dim → code filter ({"6":"P001"}). P&L-safe: see trial-balance.ts. */
    dimensions?: Record<string, string>
    /**
     * Compare with this budget (accounted#134): Budget and Avvikelse figures
     * on every row, and rows for accounts budgeted but not booked. Whole
     * months only (report-budget.ts); a budget line matches the dimension
     * filter by containment, as a journal line does.
     */
    budgetId?: string
  }
): Promise<ResultatrapportReport> {
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end, previous_period_id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (!period) {
    throw new Error('Fiscal period not found')
  }

  const effectiveFromDate = options?.fromDate ?? period.period_start
  const effectiveToDate = options?.toDate ?? period.period_end

  // Prior-period comparison. Full period: the previous fiscal period.
  // Narrowed range: the same window shifted one year back (#862), so
  // "Hittills i år" compares against the same dates last year.
  // Dimension filter: no comparison at all; project codes are time-limited
  // under K2/K3 (registry start/end dates), so "this code last year" may be
  // a different project entirely: drop the column rather than compare
  // unrelated activity (#862 review).
  const hasRange = Boolean(options?.fromDate || options?.toDate)
  const isFullPeriod = !hasRange && !options?.dimensions
  const readPrior = async (): Promise<{ rows: TrialBalanceRow[]; info: { start: string; end: string } | null }> => {
    if (isFullPeriod) {
      // The year ending the day before this one starts: the continuity link
      // when it is adjacent, the date otherwise (multi-year SIE imports created
      // before the importer set previous_period_id), never a year across a gap.
      const prior = await resolvePreviousFiscalPeriod<{ id: string; period_start: string; period_end: string }>(
        supabase,
        companyId,
        period,
        'id, period_start, period_end',
      )
      if (!prior) return { rows: [], info: null }
      // Same exclusion as the current period: a prior year is almost always
      // closed, so without it the comparison column reads zero throughout.
      const priorTb = await generateTrialBalance(supabase, companyId, prior.id, {
        closingEntry: 'exclude-all-year-end',
      })
      return { rows: filterPnl(priorTb.rows), info: { start: prior.period_start, end: prior.period_end } }
    }
    if (!hasRange || options?.dimensions) return { rows: [], info: null }
    // Same window, prior year. Shift the window back one year (leap-day
    // clamped) and read activity from whichever fiscal period(s) cover the
    // shifted dates: brutet räkenskapsår can split a calendar window across
    // two periods, so merge per account. The current period itself is a
    // valid source (a long first fiscal year can contain both windows).
    const shiftedFrom = shiftDateOneYearBack(effectiveFromDate)
    const shiftedTo = shiftDateOneYearBack(effectiveToDate)
    // A window longer than a year would overlap itself when shifted back;
    // that comparison is meaningless, so leave the column empty.
    if (shiftedTo >= effectiveFromDate) return { rows: [], info: null }
    const { data: candidatePeriods } = await supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end')
      .eq('company_id', companyId)
      .lte('period_start', shiftedTo)
      .gte('period_end', shiftedFrom)
      .order('period_start', { ascending: true })

    const parts = (candidatePeriods ?? [])
      .map((p) => ({
        id: p.id,
        from: shiftedFrom > p.period_start ? shiftedFrom : p.period_start,
        to: shiftedTo < p.period_end ? shiftedTo : p.period_end,
      }))
      .filter((part) => part.from <= part.to)
    if (parts.length === 0) return { rows: [], info: null }
    // Each covering period's slice is read at once, merged in period order.
    const tbParts = await Promise.all(
      parts.map((part) =>
        generateTrialBalance(supabase, companyId, part.id, {
          closingEntry: 'exclude-all-year-end',
          fromDate: part.from,
          toDate: part.to,
        }),
      ),
    )
    const merged = new Map<string, TrialBalanceRow>()
    for (const tbPart of tbParts) {
      for (const row of filterPnl(tbPart.rows)) {
        const existing = merged.get(row.account_number)
        if (!existing) {
          merged.set(row.account_number, { ...row })
        } else {
          existing.period_debit = roundOre(existing.period_debit + row.period_debit)
          existing.period_credit = roundOre(existing.period_credit + row.period_credit)
        }
      }
    }
    return { rows: [...merged.values()], info: { start: shiftedFrom, end: shiftedTo } }
  }

  // Reconciliation aid for the header: which vouchers are actually in here.
  // Scoped to the reported window, so a Q1 report says something true about Q1.
  // Dimension filter: skipped entirely. The report already discloses that it is
  // partial, and an unfiltered voucher range next to a filtered result invites
  // exactly the wrong conclusion during avstämning.
  // Best-effort: a header nicety never breaks the report.
  const readLatestVouchers = async (): Promise<LatestVoucherPerSeries[]> => {
    if (options?.dimensions) return []
    try {
      return await getLatestPostedVouchers(supabase, companyId, fiscalPeriodId, {
        fromDate: effectiveFromDate,
        toDate: effectiveToDate,
      })
    } catch {
      // Best-effort header line only.
      return []
    }
  }

  // Every read below depends only on the period: one round of reads, not
  // four in a row (the report page waits on all of them).
  const [currentRows, prior, budget, latestVouchers] = await Promise.all([
    resultatrapportRows(supabase, companyId, fiscalPeriodId, {
      fromDate: options?.fromDate,
      toDate: options?.toDate,
      dimensions: options?.dimensions,
    }),
    readPrior(),
    options?.budgetId
      ? loadReportBudget(supabase, companyId, {
          budgetId: options.budgetId,
          fiscalPeriodId,
          period: { start: period.period_start, end: period.period_end },
          window: { from: effectiveFromDate, to: effectiveToDate },
          dimensions: options.dimensions,
        })
      : Promise.resolve(null),
    readLatestVouchers(),
  ])
  const priorRows = prior.rows
  const priorPeriodInfo = prior.info

  const priorByAccount = new Map<string, TrialBalanceRow>()
  for (const r of priorRows) priorByAccount.set(r.account_number, r)

  const groups = buildGroups(currentRows, priorByAccount, budget?.info.applied ? budget : null)

  const netResultCurrent = sumNet(currentRows)
  const netResultPrior = sumNet(priorRows)

  return {
    groups,
    net_result_current: roundOre(netResultCurrent),
    net_result_prior: roundOre(netResultPrior),
    period: { start: effectiveFromDate, end: effectiveToDate },
    prior_period: priorPeriodInfo,
    ...(latestVouchers.length > 0 ? { latest_vouchers: latestVouchers } : {}),
    ...(budget ? { budget: budget.info } : {}),
    ...(budget?.info.applied
      ? { net_result_budget: comparison(sumBudget(budget), netResultCurrent) }
      : {}),
  }
}

/** Budget, deviation and deviation % for one figure (both in the report's sign). */
function comparison(budget: number, actual: number): BudgetComparison {
  const f = figures(budget, actual)
  return { budget: f.budget, deviation: f.deviation, deviation_percent: f.deviation_percent }
}

function sumBudget(budget: LoadedReportBudget): number {
  return [...budget.byAccount.values()].reduce((s, v) => s + v, 0)
}

/**
 * The report's current-window rows: the trial-balance row of every class 3-8
 * account for [fromDate, toDate] (default: the whole period), read with
 * signedAmount below. Exported for the dimension P&L (dimension-pnl.ts),
 * whose Totalt column must be exactly this report for the same window. The
 * two used to restate these choices separately and drifted apart when this
 * report moved from closing to window amounts; now there is one definition.
 */
export async function resultatrapportRows(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: {
    fromDate?: string
    toDate?: string
    dimensions?: Record<string, string>
  }
): Promise<TrialBalanceRow[]> {
  // Exclude year-end closing entries. Without this a closed year reads ZERO on
  // every line: the resultatavslut posts the mirror image of each P&L account
  // into 2099 inside the same period, so the period movements this report sums
  // net out exactly.
  //
  // 'exclude-all-year-end', NOT 'exclude-final', so this report keeps showing
  // the same profit as the formal Resultaträkning. Moving
  // generateIncomeStatement to 'exclude-final' is Stage 2 of #1051 and
  // deliberately deferred: see DECISIONS.md archive 2026-07-29. When that lands, this call
  // site moves with it.
  const tb = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    closingEntry: 'exclude-all-year-end',
    fromDate: options?.fromDate,
    toDate: options?.toDate,
    dimensions: options?.dimensions,
  })
  return filterPnl(tb.rows)
}

function filterPnl(rows: TrialBalanceRow[]): TrialBalanceRow[] {
  return rows.filter((r) => r.account_class >= 3 && r.account_class <= 8)
}

/**
 * Sign convention: revenue (class 3) has credit normal balance, expenses
 * (class 4-7) have debit. We render every line as `credit - debit` so that
 * revenue is positive, expenses are negative, and a positive net result
 * means profit. This matches how Fortnox and Visma present a Resultatrapport.
 *
 * Window activity (`period_*`), not `closing_*`: when fromDate > period_start
 * the trial balance rolls pre-window activity into the opening columns, so
 * `closing_*` on a P&L account would silently report year-to-date amounts in
 * a month/quarter window. In the full-period case P&L accounts carry no
 * opening balance, so period_* equals closing_* and nothing changes there.
 */
export function signedAmount(row: TrialBalanceRow): number {
  return row.period_credit - row.period_debit
}

/**
 * `2026-03-15` -> `2025-03-15`; leap day clamps to the target month's last
 * day (`2028-02-29` -> `2027-02-28`). String math on the ISO parts: no Date
 * object, no timezone edge.
 */
export function shiftDateOneYearBack(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const year = y - 1
  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const day = Math.min(d, daysInMonth[m - 1])
  return `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function sumNet(rows: TrialBalanceRow[]): number {
  return rows.reduce((sum, r) => sum + signedAmount(r), 0)
}

function buildGroups(
  currentRows: TrialBalanceRow[],
  priorByAccount: Map<string, TrialBalanceRow>,
  budget: LoadedReportBudget | null,
): ResultatrapportGroup[] {
  const accountIndex = new Map<string, { name: string; class: number }>()
  for (const r of currentRows) {
    accountIndex.set(r.account_number, { name: r.account_name, class: r.account_class })
  }
  for (const r of priorByAccount.values()) {
    if (!accountIndex.has(r.account_number)) {
      accountIndex.set(r.account_number, { name: r.account_name, class: r.account_class })
    }
  }
  // An account budgeted but not booked is a row too: its whole budget is the
  // deviation, and leaving it out would hide exactly the shortfall.
  for (const account of budget?.byAccount.keys() ?? []) {
    if (!accountIndex.has(account)) {
      accountIndex.set(account, { name: budget!.accountNames.get(account) ?? '', class: Number(account[0]) })
    }
  }

  const currentByAccount = new Map<string, TrialBalanceRow>()
  for (const r of currentRows) currentByAccount.set(r.account_number, r)

  const groups: ResultatrapportGroup[] = []
  for (const klass of [3, 4, 5, 6, 7, 8] as const) {
    const accountsInClass = [...accountIndex.entries()]
      .filter(([, info]) => info.class === klass)
      .map(([account_number, info]) => ({ account_number, name: info.name }))
      .sort((a, b) => a.account_number.localeCompare(b.account_number))

    const rows: ResultatrapportRow[] = []
    let subtotalCurrent = 0
    let subtotalPrior = 0
    let subtotalBudget = 0
    for (const { account_number, name } of accountsInClass) {
      const cur = currentByAccount.get(account_number)
      const pr = priorByAccount.get(account_number)
      const currentAmount = cur ? signedAmount(cur) : 0
      const priorAmount = pr ? signedAmount(pr) : 0
      const budgetAmount = budget?.byAccount.get(account_number) ?? 0
      if (Math.abs(currentAmount) < 0.005 && Math.abs(priorAmount) < 0.005 && Math.abs(budgetAmount) < 0.005) continue
      rows.push({
        account_number,
        account_name: name,
        current_period: roundOre(currentAmount),
        prior_period: roundOre(priorAmount),
        ...(budget ? { budget: comparison(budgetAmount, currentAmount) } : {}),
      })
      subtotalCurrent += currentAmount
      subtotalPrior += priorAmount
      subtotalBudget += budgetAmount
    }

    if (rows.length === 0) continue

    groups.push({
      class: klass,
      class_label: CLASS_LABELS[klass],
      rows,
      subtotal_current: roundOre(subtotalCurrent),
      subtotal_prior: roundOre(subtotalPrior),
      ...(budget ? { subtotal_budget: comparison(subtotalBudget, subtotalCurrent) } : {}),
    })
  }

  return groups
}

