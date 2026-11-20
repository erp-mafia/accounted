import { NextResponse } from 'next/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { parseReportDateRange, type DateRange } from '@/lib/reports/date-range'
import { DimensionCrossNotReadyError, dimensionCrossAxesError, type DimensionCrossAxes } from './dimension-cross'
import type { RouteContext } from '@/lib/api/with-route-context'

/**
 * The query every dashboard route of the dimension cross report takes:
 * period_id, dim_a and dim_b (the row and column dimensions), optionally
 * account_from and account_to (the measure; default the whole result) and
 * from_date and to_date (the window inside the period). Answers the 400 or
 * 404 itself, so each route reads as its report.
 */
export async function readDimensionCrossRequest(
  request: Request,
  ctx: Pick<RouteContext, 'supabase' | 'companyId' | 'log' | 'requestId'>,
): Promise<
  | { ok: true; periodId: string; axes: DimensionCrossAxes; range: DateRange; searchParams: URLSearchParams }
  | { ok: false; response: NextResponse }
> {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')
  if (!periodId) {
    return { ok: false, response: errorResponseFromCode('REPORT_PERIOD_REQUIRED', ctx.log, { requestId: ctx.requestId }) }
  }
  const axes: DimensionCrossAxes = {
    dimA: searchParams.get('dim_a') ?? '',
    dimB: searchParams.get('dim_b') ?? '',
    accountFrom: searchParams.get('account_from') ?? undefined,
    accountTo: searchParams.get('account_to') ?? undefined,
  }
  const invalid = dimensionCrossAxesError(axes)
  if (invalid) return { ok: false, response: NextResponse.json({ error: invalid }, { status: 400 }) }

  const { data: period } = await ctx.supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', periodId)
    .eq('company_id', ctx.companyId!)
    .single()
  if (!period) {
    return { ok: false, response: NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 }) }
  }
  const parsed = parseReportDateRange(searchParams, period)
  if (!parsed.ok) return { ok: false, response: NextResponse.json({ error: parsed.error }, { status: 400 }) }

  return { ok: true, periodId, axes, range: parsed.range, searchParams }
}

/** A failed generation as the routes answer it: not deployed yet, or failed. */
export function dimensionCrossFailure(
  err: unknown,
  ctx: Pick<RouteContext, 'log' | 'requestId'>,
  what: string,
): NextResponse {
  if (err instanceof DimensionCrossNotReadyError) {
    return errorResponseFromCode('REPORT_NOT_READY', ctx.log, { requestId: ctx.requestId })
  }
  ctx.log.error(`${what} failed`, err as Error)
  return errorResponseFromCode('REPORT_GENERATION_FAILED', ctx.log, { requestId: ctx.requestId })
}
