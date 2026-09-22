import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'

export const GET = withRouteContext('report.monthly_breakdown', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  try {
    const data = await generateMonthlyBreakdown(supabase, companyId, periodId, {
      dimensions: dimFilter.dimensions,
    })
    return NextResponse.json({ data })
  } catch {
    return NextResponse.json({ error: 'Failed to generate monthly breakdown' }, { status: 500 })
  }
})
