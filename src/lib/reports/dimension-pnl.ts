import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { resultatrapportRows, signedAmount } from './resultatrapport'
import { excludeYearEndChain, fetchReversedYearEndEntryIds } from './trial-balance'
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
 * Reconciliation is by construction, not by convention: the Totalt column is
 * the resultatrapport's own current-window rows and sign (resultatrapportRows
 * and signedAmount, imported rather than restated), and the untagged bucket
 * is the residual Totalt − tagged columns. The tagged pass reads the same
 * entries as the trial balance behind Totalt (same window, no opening-balance
 * entry, no year-end entries or their storno chain via the shared
 * excludeYearEndChain), so the columns sum exactly to the resultatrapport for
 * the same window.
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
  options?: { fromDate?: string; toDate?: string }
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
  // moved from closing to window amounts). The reversed year-end roots feed
  // the tagged pass's matching exclusion below.
  const [pnlRows, reversedYearEndIds] = await Promise.all([
    resultatrapportRows(supabase, companyId, fiscalPeriodId, {
      fromDate: options?.fromDate,
      toDate: options?.toDate,
    }),
    fetchReversedYearEndEntryIds(supabase, companyId),
  ])
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
  // The entries the trial balance behind Totalt sums, and no others: this
  // period, posted or reversed, inside the window, without the
  // opening-balance entry (IB, not activity) and without year-end entries
  // and their storno chain. A set dropped on one side only would land in its
  // value column with the opposite amount in "(Utan dimension)": a retagged
  // year-end depreciation read KS01 −50 000 and untagged +50 000 against a
  // Totalt of 0, disagreeing with the filtered resultatrapport.
  const taggedLines = await fetchEntryLines<{
    id: string
    account_number: string
    debit_amount: number
    credit_amount: number
    dimensions: Record<string, string>
  }>({
    supabase,
    lineColumns: 'id, account_number, debit_amount, credit_amount, dimensions',
    filterEntries: (q: EntryLinesQuery) => {
      let query = q
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .in('status', ['posted', 'reversed'])

      if (options?.fromDate) {
        query = query.gte('entry_date', options.fromDate)
      }
      if (options?.toDate) {
        query = query.lte('entry_date', options.toDate)
      }
      if (period.opening_balance_entry_id) {
        query = query.neq('id', period.opening_balance_entry_id)
      }

      return excludeYearEndChain(query, reversedYearEndIds)
    },
    // Key-existence via the extracted text field: dims 1/6 ride the partial
    // expression indexes (idx_jel_dimensions_dim1/dim6).
    filterLines: (q: EntryLinesQuery) => q.not(`dimensions->>${sieDimNo}`, 'is', null),
  })

  // Bucket raw amounts per (account, code). Only accounts present in the P&L
  // trial-balance scope count: anything else (balance accounts) is out.
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
  // resultatrapport's net_result_current, computed the way it computes it:
  // the rounded sum of signedAmount over the same rows.
  const netTotal = round2(pnlRows.reduce((s, r) => s + signedAmount(r), 0))

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
  }
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
