import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'
import { requireCompanyId } from '@/lib/company/context'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

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
}
