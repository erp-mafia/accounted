import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { generateAvgifterBasis } from '@/lib/reports/avgifter-basis'
import { getErrorMessage } from '@/lib/errors/get-error-message'

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
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 })
  }
})
