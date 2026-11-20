import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchDimensionCrossLines, type DimensionCrossCursor } from '@/lib/reports/dimension-cross'
import { dimensionCrossFailure, readDimensionCrossRequest } from '@/lib/reports/dimension-cross-request'
import { isIsoDateShaped } from '@/lib/invariants'
import { isUuid } from '@/lib/invariants/uuid'

/**
 * The lines behind one cell of the dimension cross report, a page at a
 * time. code_a and code_b name the cell (left out or blank: the "(Utan
 * dimension)" row or column); after_date, after_voucher and after_line (the
 * page's `next`) continue it.
 */
export const GET = withRouteContext('report.dimension_cross.lines', async (request, ctx) => {
  const req = await readDimensionCrossRequest(request, ctx)
  if (!req.ok) return req.response
  const { searchParams } = req

  const afterDate = searchParams.get('after_date')
  const afterVoucher = searchParams.get('after_voucher')
  const afterLine = searchParams.get('after_line')
  let after: DimensionCrossCursor | undefined
  if (afterDate || afterVoucher || afterLine) {
    if (!isIsoDateShaped(afterDate) || !afterVoucher || !/^\d+$/.test(afterVoucher) || !isUuid(afterLine)) {
      return NextResponse.json({ error: 'after_date, after_voucher and after_line go together' }, { status: 400 })
    }
    after = { date: afterDate as string, voucher_number: Number(afterVoucher), line_id: afterLine as string }
  }

  try {
    const data = await fetchDimensionCrossLines(ctx.supabase, ctx.companyId!, req.periodId, {
      ...req.axes,
      codeA: searchParams.get('code_a'),
      codeB: searchParams.get('code_b'),
      fromDate: req.range.fromDate,
      toDate: req.range.toDate,
      after,
    })
    return NextResponse.json({ data })
  } catch (err) {
    return dimensionCrossFailure(err, ctx, 'dimension cross lines')
  }
})
