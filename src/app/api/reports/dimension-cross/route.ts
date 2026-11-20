import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { generateDimensionCross } from '@/lib/reports/dimension-cross'
import { dimensionCrossFailure, readDimensionCrossRequest } from '@/lib/reports/dimension-cross-request'

// Resultat across two dimensions (accounted#133): dim_a's values as rows,
// dim_b's as columns, one amount per cell; account_from and account_to
// narrow the measure from the whole result to a range of result accounts.
export const GET = withRouteContext('report.dimension_cross', async (request, ctx) => {
  const req = await readDimensionCrossRequest(request, ctx)
  if (!req.ok) return req.response
  try {
    const data = await generateDimensionCross(ctx.supabase, ctx.companyId!, req.periodId, {
      ...req.axes,
      fromDate: req.range.fromDate,
      toDate: req.range.toDate,
    })
    return NextResponse.json({ data })
  } catch (err) {
    return dimensionCrossFailure(err, ctx, 'dimension cross report')
  }
})
