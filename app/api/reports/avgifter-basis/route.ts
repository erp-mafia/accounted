import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { generateAvgifterBasis } from '@/lib/reports/avgifter-basis'

/**
 * Arbetsgivaravgiftsunderlag report.
 * Monthly breakdown by avgifter rate category for AGI reconciliation.
 * Per BFL: Part of räkenskapsinformation, 7-year retention.
 */
export const GET = withRouteContext('report.avgifter_basis', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString())

  try {
    const report = await generateAvgifterBasis(supabase, companyId, year)
    return NextResponse.json({ data: report })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Kunde inte generera avgiftsunderlag'
    return NextResponse.json({ error: message }, { status: 500 })
  }
})
