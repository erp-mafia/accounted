/**
 * Metric selection for gnubok_get_kpi_report.
 *
 * Callers asked for one KPI by name (`metric`) thousands of times and were
 * rejected, because the tool only took a period. The metric keys are now a
 * real, enumerated filter: the report is still computed whole, and only the
 * requested metrics are returned next to the period fields.
 */

export const KPI_METRIC_KEYS = [
  'gross_margin',
  'net_result',
  'cash_position',
  'outstanding_receivables',
  'overdue_receivables',
  'expense_ratio',
  'avg_payment_days',
  'paid_invoice_count',
  'vat_liability',
  'total_revenue',
  'total_expenses',
  'months',
] as const

export type KpiMetricKey = (typeof KPI_METRIC_KEYS)[number]

/** Fields every KPI response carries, whatever the metric filter. */
const KPI_CONTEXT_KEYS = [
  'period_name',
  'period_start',
  'period_end',
  'range',
  'receivables_as_of',
] as const

/**
 * Validate the `metrics` argument. Undefined or empty means every metric;
 * an unknown name is an argument error that lists the valid names.
 */
export function parseKpiMetrics(raw: unknown): KpiMetricKey[] | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) {
    throw new Error(`metrics must be an array of metric names. Valid: ${KPI_METRIC_KEYS.join(', ')}.`)
  }
  if (raw.length === 0) return null
  const unknown = raw.filter(
    (m) => typeof m !== 'string' || !(KPI_METRIC_KEYS as readonly string[]).includes(m),
  )
  if (unknown.length > 0) {
    throw new Error(
      `Unknown metric(s): ${unknown.map((m) => JSON.stringify(m)).join(', ')}. Valid: ${KPI_METRIC_KEYS.join(', ')}.`,
    )
  }
  return [...new Set(raw as KpiMetricKey[])]
}

export function pickKpiMetrics<T extends Record<string, unknown>>(
  report: T,
  metrics: KpiMetricKey[] | null,
): Record<string, unknown> {
  if (!metrics) return report
  const picked: Record<string, unknown> = {}
  for (const key of [...KPI_CONTEXT_KEYS, ...metrics]) {
    if (key in report) picked[key] = report[key]
  }
  return picked
}

const num = { type: 'number' }
const nullableNum = { type: ['number', 'null'] }

/**
 * Kept to bare types and to the metric keys (plus the new as-of date): this
 * schema rides the default tools/list, which has no headroom
 * (payload-size.bench.test.ts). The property names double as the valid
 * `metrics` values, so the input schema does not repeat them as an enum. The
 * period echo fields (period_name, period_start, period_end, range) are
 * returned but not declared.
 */
export const KPI_REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    receivables_as_of: { type: ['string', 'null'] },
    gross_margin: nullableNum,
    net_result: num,
    cash_position: num,
    outstanding_receivables: num,
    overdue_receivables: num,
    expense_ratio: nullableNum,
    avg_payment_days: nullableNum,
    paid_invoice_count: num,
    vat_liability: num,
    total_revenue: num,
    total_expenses: num,
    months: { type: 'array' },
  },
} as const
