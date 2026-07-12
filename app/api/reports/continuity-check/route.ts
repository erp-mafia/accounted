import { NextResponse } from 'next/server'
import { validateBalanceContinuity } from '@/lib/reports/continuity-check'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * GET: Validate IB/UB continuity for a fiscal period.
 * Query param: period_id (required)
 */
export const GET = withRouteContext('report.continuity_check', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  try {
    const result = await validateBalanceContinuity(supabase, companyId, periodId)
    return NextResponse.json({ data: result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to validate continuity' },
      { status: 400 }
    )
  }
})
