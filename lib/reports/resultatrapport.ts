import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import type {
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
 * Resultatrapport — operational P&L report.
 *
 * Lists every account in classes 3–8 with current-period and prior-period
 * values side by side. Unlike Resultaträkning (formal, ÅRL Bilaga 2), this
 * keeps account numbers and is meant for ongoing reconciliation, not for
 * årsbokslut/årsredovisning.
 *
 * Account 8999 is excluded — it's the year-end closing account that moves
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

  const currentTb = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    fromDate: options?.fromDate,
    toDate: options?.toDate,
    dimensions: options?.dimensions,
  })
  const currentRows = filterPnl(currentTb.rows)

  // Prior-period comparison stays full-year. A narrower current window
  // compared against a full prior year would be misleading; until we ship a
  // proper "same window, prior year" comparison the cleanest move is to
  // drop the prior column entirely when the user narrows the range.
  // Same rule for a dimension filter: project codes are time-limited under
  // K2/K3 (registry start/end dates), so "this code last year" may be a
  // different project entirely — drop the column rather than compare
  // unrelated activity (#862 review).
  let priorRows: TrialBalanceRow[] = []
  let priorPeriodInfo: { start: string; end: string } | null = null
  const isFullPeriod = !options?.fromDate && !options?.toDate && !options?.dimensions
  if (isFullPeriod) {
    // Prefer the explicit continuity chain; fall back to the period that ends
    // immediately before this one. The fallback keeps the comparison working
    // for companies whose chain was never linked — e.g. multi-year SIE imports
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
        const priorTb = await generateTrialBalance(supabase, companyId, priorPeriodId)
        priorRows = filterPnl(priorTb.rows)
        priorPeriodInfo = { start: prior.period_start, end: prior.period_end }
      }
    }
  }

  const priorByAccount = new Map<string, TrialBalanceRow>()
  for (const r of priorRows) priorByAccount.set(r.account_number, r)

  const groups = buildGroups(currentRows, priorByAccount)

  const netResultCurrent = sumNet(currentRows)
  const netResultPrior = sumNet(priorRows)

  return {
    groups,
    net_result_current: round2(netResultCurrent),
    net_result_prior: round2(netResultPrior),
    period: { start: effectiveFromDate, end: effectiveToDate },
    prior_period: priorPeriodInfo,
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
 * (class 4–7) have debit. We render every line as `credit - debit` so that
 * revenue is positive, expenses are negative, and a positive net result
 * means profit. This matches how Fortnox and Visma present a Resultatrapport.
 */
function signedAmount(row: TrialBalanceRow): number {
  return row.closing_credit - row.closing_debit
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
