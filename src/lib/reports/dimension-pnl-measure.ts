/**
 * The per-dimension report's budget view (accounted#134): one matrix shape,
 * three measures. Utfall is the report as booked; Budget the budget per value
 * column; Avvikelse utfall minus budget, positive a better result, as in the
 * resultatrapport. The page's toggle and the xlsx export's sheets read the
 * same function, so the two cannot disagree. Pure, safe in the browser.
 */
import { roundOre } from '@/lib/money'
import type { DimensionPnlReport } from '@/types'

export type DimensionPnlMeasure = 'actual' | 'budget' | 'deviation'

export function dimensionPnlMeasure(report: DimensionPnlReport, measure: DimensionPnlMeasure): DimensionPnlReport {
  if (measure === 'actual' || !report.budget?.applied) return report
  const many = (actual: number[], budget: number[] | undefined): number[] =>
    actual.map((v, i) => {
      const b = budget?.[i] ?? 0
      return measure === 'budget' ? b : roundOre(v - b)
    })
  const one = (actual: number, budget: number | undefined): number =>
    measure === 'budget' ? (budget ?? 0) : roundOre(actual - (budget ?? 0))

  return {
    ...report,
    groups: report.groups.map((g) => ({
      ...g,
      rows: g.rows.map((r) => ({ ...r, values: many(r.values, r.budget_values), total: one(r.total, r.budget_total) })),
      subtotals: many(g.subtotals, g.budget_subtotals),
      subtotal_total: one(g.subtotal_total, g.budget_subtotal_total),
    })),
    net_per_column: many(report.net_per_column, report.budget_net_per_column),
    net_total: one(report.net_total, report.budget_net_total),
  }
}
