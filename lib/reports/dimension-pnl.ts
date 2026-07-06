import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { generateTrialBalance } from './trial-balance'
import type {
  DimensionPnlColumn,
  DimensionPnlGroup,
  DimensionPnlReport,
  DimensionPnlRow,
  TrialBalanceRow,
} from '@/types'

// Same class labels as resultatrapport: the report is its per-dimension
// sibling and must read identically. Stays-Swedish surface (report labels).
const CLASS_LABELS: Record<number, string> = {
  3: '3 Rörelsens inkomster/intäkter',
  4: '4 Material- och varukostnader',
  5: '5 Övriga externa kostnader',
  6: '6 Övriga externa kostnader',
  7: '7 Personalkostnader',
  8: '8 Finansiella poster och bokslutsdispositioner',
}

/**
 * Resultat per projekt / kostnadsställe (Fortnox "Resultatrapport projekt").
 *
 * Value-as-column P&L matrix over ONE SIE dimension: every registered value
 * with activity becomes a column, plus an explicit "(Utan dimension)" bucket.
 *
 * Reconciliation is by construction, not by convention: the Totalt column
 * comes from the SAME unfiltered generateTrialBalance pass resultatrapport
 * uses (same options, same filterPnl scope, same sign convention), and the
 * untagged bucket is the residual Totalt − tagged columns. Columns therefore
 * always sum exactly to the unfiltered resultatrapport: including edge cases
 * the line pass cannot see (e.g. P&L opening remnants when a prior year was
 * never closed), which land in "(Utan dimension)" where they belong.
 */
export async function generateDimensionPnl(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  sieDimNo: string,
  // No fromDate: the matrix uses closing-balance semantics (cumulative from
  // period_start) to reconcile with resultatrapport, so a lower bound cannot
  // be honoured: accepting one and labelling the report with it would be a
  // lie (#862 review). toDate caps the window on both sides identically.
  options?: { toDate?: string }
): Promise<DimensionPnlReport> {
  // The dim number is interpolated into a PostgREST jsonb path expression
  // below (`dimensions->>N`). Both entry points (route, MCP tool) validate,
  // but the generator is exported: guard here too so no future caller can
  // smuggle filter syntax through.
  if (!/^[1-9]\d{0,3}$/.test(sieDimNo)) {
    throw new Error('sieDimNo must be a positive SIE dimension number')
  }

  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (!period) {
    throw new Error('Fiscal period not found')
  }

  // ── Totalt column: identical inputs to resultatrapport ─────────
  const tb = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    toDate: options?.toDate,
  })
  const pnlRows = filterPnl(tb.rows)
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

  // ── Tagged lines: one pass over lines carrying this dimension ──
  // Mirrors trial-balance closing semantics: the fiscal_period_id join scopes
  // to the period and toDate caps the window: both sides of the matrix
  // cover period_start..toDate, so the buckets sum to the Totalt column.
  const taggedLines = await fetchAllRows<{
    id: string
    account_number: string
    debit_amount: number
    credit_amount: number
    dimensions: Record<string, string>
  }>(({ from, to }) => {
    let query = supabase
      .from('journal_entry_lines')
      .select(
        'id, account_number, debit_amount, credit_amount, dimensions, journal_entries!inner(company_id, fiscal_period_id, status, entry_date)'
      )
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
      .in('journal_entries.status', ['posted', 'reversed'])
      // Key-existence via the extracted text field: dims 1/6 ride the partial
      // expression indexes (idx_jel_dimensions_dim1/dim6).
      .not(`dimensions->>${sieDimNo}`, 'is', null)

    if (options?.toDate) {
      query = query.lte('journal_entries.entry_date', options.toDate)
    }

    // Stable total order on the line PK for correct paging (see fetch-all.ts).
    return query.order('id', { ascending: true }).range(from, to)
  }, { dedupeBy: (r) => r.id })

  // Bucket raw amounts per (account, code). Only accounts present in the P&L
  // trial-balance scope count: anything else (balance accounts, 8999) is out.
  const buckets = new Map<string, Map<string, { debit: number; credit: number }>>()
  const codesSeen = new Set<string>()
  for (const line of taggedLines) {
    if (!totalByAccount.has(line.account_number)) continue
    const code = normalizeCode(line.dimensions?.[sieDimNo])
    if (!code) continue
    codesSeen.add(code)
    const byCode = buckets.get(line.account_number) ?? new Map()
    const agg = byCode.get(code) ?? { debit: 0, credit: 0 }
    agg.debit += Number(line.debit_amount) || 0
    agg.credit += Number(line.credit_amount) || 0
    byCode.set(code, agg)
    buckets.set(line.account_number, byCode)
  }

  const codes = [...codesSeen].sort((a, b) => a.localeCompare(b, 'sv'))

  // ── Matrix rows: tagged columns + untagged residual + Totalt ───
  // Per account: values[i] = round2(signed bucket), untagged = round2(total −
  // Σ rounded tagged) so the row sums exactly; total = signedAmount(tb row),
  // the very number resultatrapport renders for the account.
  type AccountRow = DimensionPnlRow & { account_class: number }
  const accountRows: AccountRow[] = []
  let anyUntagged = false

  for (const tbRow of pnlRows) {
    const total = round2(signedAmount(tbRow))
    const byCode = buckets.get(tbRow.account_number)
    const tagged = codes.map((code) => {
      const agg = byCode?.get(code)
      return agg ? round2(agg.credit - agg.debit) : 0
    })
    const untagged = round2(total - tagged.reduce((s, v) => s + v, 0))
    if (Math.abs(untagged) >= 0.005) anyUntagged = true

    const values = [...tagged, untagged]
    if (Math.abs(total) < 0.005 && values.every((v) => Math.abs(v) < 0.005)) continue

    accountRows.push({
      account_number: tbRow.account_number,
      account_name: tbRow.account_name,
      account_class: tbRow.account_class,
      values,
      total,
    })
  }

  // Drop the untagged column when everything is tagged.
  const columnCount = codes.length + (anyUntagged ? 1 : 0)
  if (!anyUntagged) {
    for (const row of accountRows) row.values = row.values.slice(0, codes.length)
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
      round2(rows.reduce((s, r) => s + r.values[i], 0))
    )
    groups.push({
      class: klass,
      class_label: CLASS_LABELS[klass],
      rows: rows.map(({ account_class: _klass, ...row }) => row),
      subtotals,
      subtotal_total: round2(rows.reduce((s, r) => s + r.total, 0)),
    })
  }

  const netPerColumn = Array.from({ length: columnCount }, (_, i) =>
    round2(accountRows.reduce((s, r) => s + r.values[i], 0))
  )
  // Same aggregation as resultatrapport's net_result_current: sum of the
  // per-account rounded signed amounts over the filterPnl scope.
  const netTotal = round2(pnlRows.reduce((s, r) => s + round2(signedAmount(r)), 0))

  return {
    dimension: {
      sie_dim_no: sieDimNo,
      name: dimRow?.name ?? defaultDimensionName(sieDimNo),
    },
    columns,
    groups,
    net_per_column: netPerColumn,
    net_total: netTotal,
    // The label reflects actual coverage: always cumulative from
    // period_start (closing-balance semantics), capped at toDate.
    period: {
      start: period.period_start,
      end: options?.toDate ?? period.period_end,
    },
  }
}

function filterPnl(rows: TrialBalanceRow[]): TrialBalanceRow[] {
  return rows.filter(
    (r) => r.account_class >= 3 && r.account_class <= 8 && r.account_number !== '8999'
  )
}

// credit − debit: revenue positive, expenses negative: resultatrapport's
// exact sign convention, so cells compare 1:1 with that report.
function signedAmount(row: TrialBalanceRow): number {
  return row.closing_credit - row.closing_debit
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

function round2(n: number): number {
  return roundOre(n)
}
