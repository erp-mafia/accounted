import { DimensionsBagSchema } from '@/lib/bookkeeping/dimension-resolver'

/**
 * Parse the report-route dimension filter pair (?dim_no=6&dim_code=P001)
 * into the `dimensions` option the report generators accept.
 *
 * Absent params are fine (unfiltered report). A half-provided pair or a
 * value that fails DimensionsBagSchema (SIE framing charset, length) is a
 * 400 — never silently ignored, or the user would read an unfiltered report
 * as a filtered one.
 *
 * IMPORTANT: only the P&L-safe report routes may import this helper
 * (resultatrapport, income-statement, general-ledger, kpi, dimension-pnl,
 * monthly-breakdown). Statutory outputs (balance sheet, balansrapport,
 * kassaflöde, årsredovisning, INK2, NE-bilaga, VAT declaration, SIE export)
 * must never accept a dimension filter — a filtered filing is a wrong
 * filing. The whitelist is pinned by lib/reports/__tests__/
 * dimension-statutory-guard.test.ts, which fails if this import shows up in
 * a statutory route.
 */
export function parseDimensionFilterParams(searchParams: URLSearchParams):
  | { ok: true; dimensions?: Record<string, string> }
  | { ok: false; error: string } {
  const dimNo = searchParams.get('dim_no')
  const dimCode = searchParams.get('dim_code')

  if (dimNo === null && dimCode === null) {
    return { ok: true }
  }
  if (!dimNo || !dimCode) {
    return { ok: false, error: 'dim_no and dim_code must be provided together' }
  }

  const parsed = DimensionsBagSchema.safeParse({ [dimNo]: dimCode })
  if (!parsed.success) {
    return { ok: false, error: 'Invalid dimension filter' }
  }
  return { ok: true, dimensions: parsed.data }
}
