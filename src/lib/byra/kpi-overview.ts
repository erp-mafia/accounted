/**
 * Byrå cockpit Nyckeltal fetch layer (WL-16): cross-client KPI numbers.
 *
 * Read-first like the rest of the cockpit (WL-09): every query is a
 * cross-membership READ that RLS already allows via user_company_ids().
 * Per client company the numbers come from the get_kpi_report_aggregates
 * RPC (SECURITY INVOKER, one SQL pass per fiscal period; the same fast
 * path the in-company KPI route uses), so nothing here scans journal
 * lines through PostgREST.
 *
 * One RPC call per (company, fiscal period): with the byrå scale this is
 * designed for (~10 clients, 1-2 periods per range) that is a couple of
 * dozen parallel round trips. Past ~15 clients the right move is a new
 * RPC taking uuid[] (see DECISIONS.md).
 */

import { chunk as chunked } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  fetchClientOverview,
  type ClientOverview,
} from '@/lib/clients/fetch-client-overview'
import type { ClientDeadline } from '@/lib/clients/aggregate'
import {
  fetchKpiAggregates,
  buildOpeningBalances,
  buildTrialBalanceRows,
} from '@/lib/reports/kpi-aggregates'
import { calculateCashPosition, calculateVatLiability } from '@/lib/reports/kpi'
import type { MonthlyDataPoint } from '@/components/reports/IncomeExpenseChart'
import {
  filterBucketsToRange,
  mergeMonthlySeries,
  periodsInRange,
  pickCurrentPeriod,
  resolvePeriodPreset,
  resultMargin,
  sumBuckets,
  type FiscalPeriodLite,
  type KpiPeriodPreset,
  type KpiRange,
  type MonthBucket,
} from '@/lib/byra/kpi-aggregate'

const log = createLogger('byra:kpi-overview')

/** Max ids per PostgREST .in() filter (mirrors lib/clients/fetch-client-overview.ts). */
const IN_CLAUSE_CHUNK = 150

export interface ByraKpiClientRow {
  companyId: string
  name: string
  orgNumber: string | null
  revenue: number
  expenses: number
  result: number
  /** Net margin in percent, null when revenue is 0. */
  margin: number | null
  /** Closing balance of 19xx accounts for the current fiscal period. */
  cash: number
  /** Net 26xx position, positive = att betala (mirrors ruta 49). */
  vatLiability: number
  unbookedCount: number
  inboxCount: number
  nextDeadline: ClientDeadline | null
  /** True when this client's numbers could not be fetched; render dashes, not zeros. */
  failed: boolean
}

export interface ByraKpiOverview {
  team: { id: string; name: string }
  role: ClientOverview['role']
  preset: KpiPeriodPreset
  range: KpiRange
  /** Full roster for the company filter chips (unfiltered). */
  allClients: Array<{ companyId: string; name: string }>
  /** Ids the current filter selects (equals the full roster when unfiltered). */
  selectedIds: string[]
  /** One row per selected client, revenue descending. */
  rows: ByraKpiClientRow[]
  /** Merged monthly income/expense series across the selected clients. */
  months: MonthlyDataPoint[]
}

interface CompanyKpiNumbers {
  revenue: number
  expenses: number
  result: number
  margin: number | null
  cash: number
  vatLiability: number
  failed: boolean
  buckets: MonthBucket[]
}

const FAILED_NUMBERS: CompanyKpiNumbers = {
  revenue: 0,
  expenses: 0,
  result: 0,
  margin: null,
  cash: 0,
  vatLiability: 0,
  failed: true,
  buckets: [],
}

/**
 * Fetch one company's numbers: monthly P&L buckets clipped to the range,
 * plus cash and VAT from the current fiscal period's closing balances.
 * Account names are irrelevant here (nothing displays them), so the trial
 * balance rows are built with an empty account map.
 */
async function fetchCompanyNumbers(
  supabase: SupabaseClient,
  companyId: string,
  periods: FiscalPeriodLite[],
  range: KpiRange,
  todayIso: string,
): Promise<CompanyKpiNumbers> {
  const current = pickCurrentPeriod(periods, todayIso)
  const inRange = periodsInRange(periods, range)

  const needed = new Map<string, FiscalPeriodLite>()
  for (const p of inRange) needed.set(p.id, p)
  if (current) needed.set(current.id, current)
  if (needed.size === 0) {
    return { ...FAILED_NUMBERS, failed: false }
  }

  const [aggEntries, priorResult] = await Promise.all([
    Promise.all(
      [...needed.values()].map(async (period) => ({
        period,
        agg: await fetchKpiAggregates(
          supabase,
          companyId,
          period.id,
          period.opening_balance_entry_id,
        ),
      })),
    ),
    // Opening balances without an OB entry fall back to the server-side
    // prior-period aggregate, exactly like the in-company KPI route.
    current && !current.opening_balance_entry_id
      ? supabase.rpc('compute_prior_opening_balances', {
          p_company_id: companyId,
          p_period_start: current.period_start,
        })
      : Promise.resolve(null),
  ])

  if (priorResult?.error) {
    throw new Error(priorResult.error.message)
  }

  const inRangeIds = new Set(inRange.map((p) => p.id))
  const buckets: MonthBucket[] = []
  for (const { period, agg } of aggEntries) {
    if (!inRangeIds.has(period.id)) continue
    for (const m of agg.monthly) {
      buckets.push({ year: m.year, month0: m.month - 1, income: m.income, expenses: m.expenses })
    }
  }
  const rangeBuckets = filterBucketsToRange(buckets, range)
  const sums = sumBuckets(rangeBuckets)

  let cash = 0
  let vatLiability = 0
  if (current) {
    const currentAgg = aggEntries.find((e) => e.period.id === current.id)!.agg
    const openingBalances = buildOpeningBalances(
      currentAgg,
      current.opening_balance_entry_id ? null : (priorResult?.data ?? []),
    )
    const tbRows = buildTrialBalanceRows(openingBalances, currentAgg.tb, new Map())
    cash = calculateCashPosition(tbRows)
    vatLiability = calculateVatLiability(tbRows)
  }

  return {
    ...sums,
    margin: resultMargin(sums.revenue, sums.result),
    cash,
    vatLiability,
    failed: false,
    buckets: rangeBuckets,
  }
}

/**
 * Aggregate the Nyckeltal overview for the caller's byrå team. Returns null
 * when the user is not a byrå team member (the page redirects). A failing
 * client is marked `failed` and zero-weighted rather than failing the page.
 */
export async function fetchByraKpiOverview(
  supabase: SupabaseClient,
  userId: string,
  opts: { preset?: string; companyIds?: string[]; today?: Date } = {},
): Promise<ByraKpiOverview | null> {
  const overview = await fetchClientOverview(supabase, userId)
  if (!overview) return null

  const today = opts.today ?? new Date()
  const { preset, range } = resolvePeriodPreset(opts.preset, today)
  const todayIso = range.toDate

  const roster = overview.clients
  const requested = new Set(opts.companyIds ?? [])
  const validRequested = roster.filter((c) => requested.has(c.companyId))
  const selected = validRequested.length > 0 ? validRequested : roster

  const base: ByraKpiOverview = {
    team: overview.team,
    role: overview.role,
    preset,
    range,
    allClients: roster.map((c) => ({ companyId: c.companyId, name: c.name })),
    selectedIds: selected.map((c) => c.companyId),
    rows: [],
    months: [],
  }
  if (selected.length === 0) return base

  const selectedIds = base.selectedIds
  const periodRows: FiscalPeriodLite[] = []
  for (const chunk of chunked(selectedIds, IN_CLAUSE_CHUNK)) {
    const rows = await fetchAllRows<FiscalPeriodLite>(({ from, to }) =>
      supabase
        .from('fiscal_periods')
        .select('id, company_id, period_start, period_end, opening_balance_entry_id')
        .in('company_id', chunk)
        .order('id', { ascending: true })
        .range(from, to),
    )
    periodRows.push(...rows)
  }
  const periodsByCompany = new Map<string, FiscalPeriodLite[]>()
  for (const p of periodRows) {
    const list = periodsByCompany.get(p.company_id)
    if (list) list.push(p)
    else periodsByCompany.set(p.company_id, [p])
  }

  const numbers = await Promise.all(
    selected.map(async (client) => {
      try {
        return await fetchCompanyNumbers(
          supabase,
          client.companyId,
          periodsByCompany.get(client.companyId) ?? [],
          range,
          todayIso,
        )
      } catch (err) {
        log.error('byra-kpi client fetch failed', err, {
          companyId: client.companyId,
          operation: 'byra.kpi_overview',
        })
        return FAILED_NUMBERS
      }
    }),
  )

  const rows: ByraKpiClientRow[] = selected.map((client, i) => {
    const n = numbers[i]
    return {
      companyId: client.companyId,
      name: client.name,
      orgNumber: client.orgNumber,
      revenue: n.revenue,
      expenses: n.expenses,
      result: n.result,
      margin: n.margin,
      cash: n.cash,
      vatLiability: n.vatLiability,
      unbookedCount: client.unbookedCount,
      inboxCount: client.inboxCount,
      nextDeadline: client.nextDeadline,
      failed: n.failed,
    }
  })
  rows.sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, 'sv'))

  return {
    ...base,
    rows,
    months: mergeMonthlySeries(
      numbers.flatMap((n) => n.buckets),
      range,
    ),
  }
}
