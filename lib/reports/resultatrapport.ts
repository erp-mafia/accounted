import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { getLatestPostedVouchers } from './latest-vouchers'
import type {
  LatestVoucherPerSeries,
  ResultatrapportReport,
  ResultatrapportRow,
  ResultatrapportGroup,
  TrialBalanceRow,
} from '@/types'

const CLASS_LABELS: Record<number, string> = {
  3: '3 Rörelsens inkomster/intäkter',
  4: '4 Material- och varukostnader',
  5: '5 Övriga externa kostnader',
  6: '6 Övriga externa kostnader',
  7: '7 Personalkostnader',
  8: '8 Finansiella poster och bokslutsdispositioner',
}

/**
 * Resultatrapport: operational P&L report.
 *
 * Lists every account in classes 3-8 with current-period and prior-period
 * values side by side. Unlike Resultaträkning (formal, ÅRL Bilaga 2), this
 * keeps account numbers and is meant for ongoing reconciliation, not for
 * årsbokslut/årsredovisning.
 *
 * Account 8999 is excluded: it's the year-end closing account that moves
 * årets resultat into equity (2099). Including its balance would double-count
 * the result. Same exclusion as generateIncomeStatement.
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

  // Exclude year-end closing entries. Without this a closed year reads ZERO on
  // every line: the resultatavslut posts the mirror image of each P&L account
  // into 2099 inside the same period, so the period movements this report sums
  // net out exactly.
  //
  // 'exclude-all-year-end', NOT 'exclude-final', so this report keeps showing
  // the same profit as the formal Resultaträkning. Moving
  // generateIncomeStatement to 'exclude-final' is Stage 2 of #1051 and
  // deliberately deferred: see DECISIONS.md:632. When that lands, this call
  // site moves with it.
  const currentTb = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    closingEntry: 'exclude-all-year-end',
    fromDate: options?.fromDate,
    toDate: options?.toDate,
    dimensions: options?.dimensions,
  })
  const currentRows = filterPnl(currentTb.rows)

  // Prior-period comparison. Full period: the previous fiscal period.
  // Narrowed range: the same window shifted one year back (#862), so
  // "Hittills i år" compares against the same dates last year.
  // Dimension filter: no comparison at all; project codes are time-limited
  // under K2/K3 (registry start/end dates), so "this code last year" may be
  // a different project entirely: drop the column rather than compare
  // unrelated activity (#862 review).
  let priorRows: TrialBalanceRow[] = []
  let priorPeriodInfo: { start: string; end: string } | null = null
  const hasRange = Boolean(options?.fromDate || options?.toDate)
  const isFullPeriod = !hasRange && !options?.dimensions
  if (isFullPeriod) {
    // Prefer the explicit continuity chain; fall back to the period that ends
    // immediately before this one. The fallback keeps the comparison working
    // for companies whose chain was never linked: e.g. multi-year SIE imports
    // created before the importer started setting previous_period_id.
    let priorPeriodId: string | null = period.previous_period_id ?? null
    if (!priorPeriodId) {
      const { data: priorByDate } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('company_id', companyId)
        .lt('period_end', period.period_start)
        .order('period_end', { ascending: false })
        .limit(1)
      priorPeriodId = priorByDate && priorByDate.length > 0 ? priorByDate[0].id : null
    }

    if (priorPeriodId) {
      const { data: prior } = await supabase
        .from('fiscal_periods')
        .select('period_start, period_end')
        .eq('id', priorPeriodId)
        .eq('company_id', companyId)
        .single()

      if (prior) {
        // Same exclusion as the current period: a prior year is almost always
        // closed, so without it the comparison column reads zero throughout.
        const priorTb = await generateTrialBalance(supabase, companyId, priorPeriodId, {
          closingEntry: 'exclude-all-year-end',
        })
        priorRows = filterPnl(priorTb.rows)
        priorPeriodInfo = { start: prior.period_start, end: prior.period_end }
      }
    }
  } else if (hasRange && !options?.dimensions) {
    // Same window, prior year. Shift the window back one year (leap-day
    // clamped) and read activity from whichever fiscal period(s) cover the
    // shifted dates: brutet räkenskapsår can split a calendar window across
    // two periods, so merge per account. The current period itself is a
    // valid source (a long first fiscal year can contain both windows).
    const shiftedFrom = shiftDateOneYearBack(effectiveFromDate)
    const shiftedTo = shiftDateOneYearBack(effectiveToDate)
    // A window longer than a year would overlap itself when shifted back;
    // that comparison is meaningless, so leave the column empty.
    if (shiftedTo < effectiveFromDate) {
      const { data: candidatePeriods } = await supabase
        .from('fiscal_periods')
        .select('id, period_start, period_end')
        .eq('company_id', companyId)
        .lte('period_start', shiftedTo)
        .gte('period_end', shiftedFrom)
        .order('period_start', { ascending: true })

      const merged = new Map<string, TrialBalanceRow>()
      let coveredAny = false
      for (const p of candidatePeriods ?? []) {
        const from = shiftedFrom > p.period_start ? shiftedFrom : p.period_start
        const to = shiftedTo < p.period_end ? shiftedTo : p.period_end
        if (from > to) continue
        const tbPart = await generateTrialBalance(supabase, companyId, p.id, {
          closingEntry: 'exclude-all-year-end',
          fromDate: from,
          toDate: to,
        })
        coveredAny = true
        for (const row of filterPnl(tbPart.rows)) {
          const existing = merged.get(row.account_number)
          if (!existing) {
            merged.set(row.account_number, { ...row })
          } else {
            existing.period_debit = round2(existing.period_debit + row.period_debit)
            existing.period_credit = round2(existing.period_credit + row.period_credit)
          }
        }
      }
      if (coveredAny) {
        priorRows = [...merged.values()]
        priorPeriodInfo = { start: shiftedFrom, end: shiftedTo }
      }
    }
  }

  const priorByAccount = new Map<string, TrialBalanceRow>()
  for (const r of priorRows) priorByAccount.set(r.account_number, r)

  const groups = buildGroups(currentRows, priorByAccount)

  const netResultCurrent = sumNet(currentRows)
  const netResultPrior = sumNet(priorRows)

  // Reconciliation aid for the header: which vouchers are actually in here.
  // Scoped to the reported window, so a Q1 report says something true about Q1.
  // Dimension filter: skipped entirely. The report already discloses that it is
  // partial, and an unfiltered voucher range next to a filtered result invites
  // exactly the wrong conclusion during avstämning.
  // Best-effort: a header nicety never breaks the report.
  let latestVouchers: LatestVoucherPerSeries[] = []
  if (!options?.dimensions) {
    try {
      latestVouchers = await getLatestPostedVouchers(supabase, companyId, fiscalPeriodId, {
        fromDate: effectiveFromDate,
        toDate: effectiveToDate,
      })
    } catch {
      // Best-effort header line only.
    }
  }

  return {
    groups,
    net_result_current: round2(netResultCurrent),
    net_result_prior: round2(netResultPrior),
    period: { start: effectiveFromDate, end: effectiveToDate },
    prior_period: priorPeriodInfo,
    ...(latestVouchers.length > 0 ? { latest_vouchers: latestVouchers } : {}),
  }
}

function filterPnl(rows: TrialBalanceRow[]): TrialBalanceRow[] {
  return rows.filter(
    (r) =>
      r.account_class >= 3 &&
      r.account_class <= 8 &&
      r.account_number !== '8999'
  )
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
function signedAmount(row: TrialBalanceRow): number {
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
  priorByAccount: Map<string, TrialBalanceRow>
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
    for (const { account_number, name } of accountsInClass) {
      const cur = currentByAccount.get(account_number)
      const pr = priorByAccount.get(account_number)
      const currentAmount = cur ? signedAmount(cur) : 0
      const priorAmount = pr ? signedAmount(pr) : 0
      if (Math.abs(currentAmount) < 0.005 && Math.abs(priorAmount) < 0.005) continue
      rows.push({
        account_number,
        account_name: name,
        current_period: round2(currentAmount),
        prior_period: round2(priorAmount),
      })
      subtotalCurrent += currentAmount
      subtotalPrior += priorAmount
    }

    if (rows.length === 0) continue

    groups.push({
      class: klass,
      class_label: CLASS_LABELS[klass],
      rows,
      subtotal_current: round2(subtotalCurrent),
      subtotal_prior: round2(subtotalPrior),
    })
  }

  return groups
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
