import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { dbError } from '@/lib/errors/db-error'
import { resultatrapportRows, signedAmount } from './resultatrapport'
// Same class labels as resultatrapport: the report is its per-dimension
// sibling and must read identically. Stays-Swedish surface (report labels).
import { RESULT_CLASS_LABELS as CLASS_LABELS } from './result-class-labels'
import { loadReportBudget } from '@/lib/budgets/report-budget'
import type {
  DimensionPnlColumn,
  DimensionPnlGroup,
  DimensionPnlReport,
  DimensionPnlRow,
  TrialBalanceRow,
} from '@/types'

/**
 * Resultat per projekt / kostnadsställe (Fortnox "Resultatrapport projekt").
 *
 * Value-as-column P&L matrix over ONE SIE dimension: every registered value
 * with activity becomes a column, plus an explicit "(Utan dimension)" bucket.
 *
 * Reconciliation is by construction, not by convention: the Totalt column is
 * the resultatrapport's own current-window rows and sign (resultatrapportRows
 * and signedAmount, imported rather than restated), and the untagged bucket
 * is the residual Totalt − tagged columns. The tagged pass reads the same
 * entries as the trial balance behind Totalt (same window, no opening-balance
 * entry, no year-end entries or their storno chain), so the columns sum
 * exactly to the resultatrapport for the same window. That pass is one SQL
 * call, get_dimension_pnl_buckets, which reads ledger_dimension_days (paging
 * the year's tagged lines through PostgREST took ~1.8 s for 50 000 verifikat).
 */
export async function generateDimensionPnl(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  sieDimNo: string,
  // The resultatrapport's window: amounts are the activity inside
  // [fromDate, toDate], each bound defaulting to the period's own. Callers
  // validate both against the period (parseReportDateRange on the routes,
  // parseReportRangeArgs in the MCP tool), exactly as for resultatrapport.
  options?: {
    fromDate?: string
    toDate?: string
    /**
     * The budget view (accounted#134): each column's budget is the budget
     * lines tagged with that value, "(Utan dimension)" the lines without a
     * tag on this dimension, Totalt every line. A value or an account with a
     * budget but nothing booked gets its column or row. Whole months only.
     */
    budgetId?: string
  }
): Promise<DimensionPnlReport> {
  // Both entry points (route, MCP tool) validate, but the generator is
  // exported: guard here too. The number is the key read from each line's
  // bag below and the registry lookup; it is never part of a filter string.
  if (!/^[1-9]\d{0,3}$/.test(sieDimNo)) {
    throw new Error('sieDimNo must be a positive SIE dimension number')
  }

  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end, opening_balance_entry_id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (!period) {
    throw new Error('Fiscal period not found')
  }

  // ── Totalt column: the resultatrapport for this window ─────────
  // Read from resultatrapport.ts, not restated here: window, year-end
  // exclusion, class 3-8 scope and sign are one definition, so the two
  // reports cannot drift apart again (they did once, when resultatrapport
  // moved from closing to window amounts). The tagged pass runs alongside.
  const [pnlRows, bucketRows, budget] = await Promise.all([
    resultatrapportRows(supabase, companyId, fiscalPeriodId, {
      fromDate: options?.fromDate,
      toDate: options?.toDate,
    }),
    fetchTaggedBuckets(supabase, companyId, fiscalPeriodId, sieDimNo, options),
    options?.budgetId
      ? loadReportBudget(supabase, companyId, {
          budgetId: options.budgetId,
          fiscalPeriodId,
          period: { start: period.period_start, end: period.period_end },
          window: { from: options.fromDate ?? period.period_start, to: options.toDate ?? period.period_end },
          groupDim: sieDimNo,
        })
      : Promise.resolve(null),
  ])
  const budgetApplied = budget?.info.applied ? budget : null
  const totalByAccount = new Map<string, TrialBalanceRow>()
  for (const r of pnlRows) totalByAccount.set(r.account_number, r)

  // ── Registry names for column headers (read-only: never seeds) ─
  const { data: dimRow } = await supabase
    .from('dimensions')
    .select('id, sie_dim_no, name')
    .eq('company_id', companyId)
    .eq('sie_dim_no', Number(sieDimNo))
    .maybeSingle()

  const valueNames = new Map<string, string>()
  if (dimRow) {
    const values = await fetchAllRows<{ code: string; name: string }>(({ from, to }) =>
      supabase
        .from('dimension_values')
        .select('code, name')
        .eq('company_id', companyId)
        .eq('dimension_id', dimRow.id)
        .order('code', { ascending: true })
        .range(from, to)
    )
    for (const v of values) valueNames.set(v.code, v.name)
  }

  // ── Tagged buckets per (account, value) ─────────────────────────
  // Only accounts present in the P&L trial-balance scope count: anything else
  // (balance accounts) is out.
  const buckets = new Map<string, Map<string, { debit: number; credit: number }>>()
  const codesSeen = new Set<string>()
  for (const row of bucketRows) {
    if (!totalByAccount.has(row.account_number)) continue
    const code = normalizeCode(row.code)
    if (!code) continue
    codesSeen.add(code)
    const byCode = buckets.get(row.account_number) ?? new Map()
    const agg = byCode.get(code) ?? { debit: 0, credit: 0 }
    agg.debit += Number(row.debit) || 0
    agg.credit += Number(row.credit) || 0
    byCode.set(code, agg)
    buckets.set(row.account_number, byCode)
  }

  // A value with a budget but nothing booked yet (a home bought this year)
  // is a column too.
  for (const byCode of budgetApplied?.byAccountCode.values() ?? []) {
    for (const code of byCode.keys()) if (code) codesSeen.add(code)
  }

  const codes = [...codesSeen].sort((a, b) => a.localeCompare(b, 'sv'))

  // ── Matrix rows: tagged columns + untagged residual + Totalt ───
  // Per account: values[i] = roundOre(signed bucket), untagged = roundOre(total −
  // Σ rounded tagged) so the row sums exactly; total = signedAmount(tb row),
  // the very number resultatrapport renders for the account.
  type AccountRow = DimensionPnlRow & { account_class: number }
  const accountRows: AccountRow[] = []
  let anyUntagged = false

  // Budget-only accounts join the ledger's rows with nothing booked.
  const rowSources: TrialBalanceRow[] = [...pnlRows]
  for (const account of budgetApplied?.byAccount.keys() ?? []) {
    if (totalByAccount.has(account)) continue
    rowSources.push({
      account_number: account,
      account_name: budgetApplied!.accountNames.get(account) ?? '',
      account_class: Number(account[0]),
      opening_debit: 0,
      opening_credit: 0,
      period_debit: 0,
      period_credit: 0,
      closing_debit: 0,
      closing_credit: 0,
    })
  }

  for (const tbRow of rowSources) {
    const total = roundOre(signedAmount(tbRow))
    const byCode = buckets.get(tbRow.account_number)
    const tagged = codes.map((code) => {
      const agg = byCode?.get(code)
      return agg ? roundOre(agg.credit - agg.debit) : 0
    })
    const untagged = roundOre(total - tagged.reduce((s, v) => s + v, 0))
    if (Math.abs(untagged) >= 0.005) anyUntagged = true

    const values = [...tagged, untagged]
    const budgetByCode = budgetApplied?.byAccountCode.get(tbRow.account_number)
    const budgetValues = budgetApplied ? [...codes.map((code) => budgetByCode?.get(code) ?? 0), budgetByCode?.get('') ?? 0] : null
    const budgetTotal = budgetApplied?.byAccount.get(tbRow.account_number) ?? 0
    if (budgetValues && Math.abs(budgetValues[codes.length]!) >= 0.005) anyUntagged = true
    // A budget whose values cancel out over the columns (+1000 on one home,
    // -1000 on another) still has columns to show.
    if (
      Math.abs(total) < 0.005 &&
      values.every((v) => Math.abs(v) < 0.005) &&
      (budgetValues ?? []).every((v) => Math.abs(v) < 0.005) &&
      Math.abs(budgetTotal) < 0.005
    ) continue

    accountRows.push({
      account_number: tbRow.account_number,
      account_name: tbRow.account_name,
      account_class: tbRow.account_class,
      values,
      total,
      ...(budgetValues ? { budget_values: budgetValues, budget_total: budgetTotal } : {}),
    })
  }

  // Drop the untagged column when everything is tagged.
  const columnCount = codes.length + (anyUntagged ? 1 : 0)
  if (!anyUntagged) {
    for (const row of accountRows) {
      row.values = row.values.slice(0, codes.length)
      if (row.budget_values) row.budget_values = row.budget_values.slice(0, codes.length)
    }
  }

  const columns: DimensionPnlColumn[] = [
    ...codes.map((code) => ({ code, name: valueNames.get(code) ?? null })),
    ...(anyUntagged ? [{ code: null, name: null }] : []),
  ]

  // ── Groups by class, resultatrapport-style ──────────────────────
  const groups: DimensionPnlGroup[] = []
  for (const klass of [3, 4, 5, 6, 7, 8] as const) {
    const rows = accountRows
      .filter((r) => r.account_class === klass)
      .sort((a, b) => a.account_number.localeCompare(b.account_number))
    if (rows.length === 0) continue

    const subtotals = Array.from({ length: columnCount }, (_, i) =>
      roundOre(rows.reduce((s, r) => s + r.values[i], 0))
    )
    groups.push({
      class: klass,
      class_label: CLASS_LABELS[klass],
      rows: rows.map(({ account_class: _klass, ...row }) => row),
      subtotals,
      subtotal_total: roundOre(rows.reduce((s, r) => s + r.total, 0)),
      ...(budgetApplied
        ? {
            budget_subtotals: Array.from({ length: columnCount }, (_, i) =>
              roundOre(rows.reduce((s, r) => s + (r.budget_values?.[i] ?? 0), 0))
            ),
            budget_subtotal_total: roundOre(rows.reduce((s, r) => s + (r.budget_total ?? 0), 0)),
          }
        : {}),
    })
  }

  const netPerColumn = Array.from({ length: columnCount }, (_, i) =>
    roundOre(accountRows.reduce((s, r) => s + r.values[i], 0))
  )
  // resultatrapport's net_result_current, computed the way it computes it:
  // the rounded sum of signedAmount over the same rows.
  const netTotal = roundOre(pnlRows.reduce((s, r) => s + signedAmount(r), 0))

  return {
    dimension: {
      sie_dim_no: sieDimNo,
      name: dimRow?.name ?? defaultDimensionName(sieDimNo),
    },
    columns,
    groups,
    net_per_column: netPerColumn,
    net_total: netTotal,
    // The window the amounts cover, as resultatrapport labels it.
    period: {
      start: options?.fromDate ?? period.period_start,
      end: options?.toDate ?? period.period_end,
    },
    ...(budget ? { budget: budget.info } : {}),
    ...(budgetApplied
      ? {
          budget_net_per_column: Array.from({ length: columnCount }, (_, i) =>
            roundOre(accountRows.reduce((s, r) => s + (r.budget_values?.[i] ?? 0), 0))
          ),
          budget_net_total: roundOre(accountRows.reduce((s, r) => s + (r.budget_total ?? 0), 0)),
        }
      : {}),
  }
}

/**
 * The tagged pass: per account and value of the dimension, the debit and
 * credit of the lines the trial balance behind Totalt sums (this period,
 * posted or reversed, inside the window, without the opening-balance entry
 * and without year-end entries and their storno chain, the set a retagged
 * year-end depreciation once escaped: KS01 −50 000 and untagged +50 000
 * against a Totalt of 0). One row per (account, value as stored); the caller
 * trims and merges values (normalizeCode).
 */
async function fetchTaggedBuckets(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  sieDimNo: string,
  options?: { fromDate?: string; toDate?: string },
): Promise<Array<{ account_number: string; code: string; debit: number; credit: number }>> {
  const { data, error } = await supabase.rpc('get_dimension_pnl_buckets', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_dim_no: sieDimNo,
    p_from_date: options?.fromDate ?? null,
    p_to_date: options?.toDate ?? null,
  })
  if (error) throw dbError(error, 'get_dimension_pnl_buckets failed')
  return (Array.isArray(data) ? data : []) as Array<{
    account_number: string
    code: string
    debit: number
    credit: number
  }>
}

// Canonical form matching normalizeLineDimensions: trimmed, non-empty.
function normalizeCode(raw: string | undefined): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

function defaultDimensionName(sieDimNo: string): string {
  if (sieDimNo === '1') return 'Kostnadsställe'
  if (sieDimNo === '6') return 'Projekt'
  return `Dimension ${sieDimNo}`
}

