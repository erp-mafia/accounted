import { NextResponse } from 'next/server'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'
import { withRouteContext } from '@/lib/api/with-route-context'

export const GET = withRouteContext('report.kassaflodesanalys', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  try {
    const result = await generateKassaflodesanalys(supabase, companyId, periodId)
    return NextResponse.json({ data: result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate kassaflödesanalys' },
      { status: 500 }
    )
  }
})
