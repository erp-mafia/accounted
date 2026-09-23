import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateVacationLiability } from '@/lib/reports/vacation-liability'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Semesterlöneskuld report, per BFNAR 2016:10 kap 16.
 * Per-employee vacation liability (accounts 2920 + 2940).
 * Required for year-end closing.
 */
export const GET = withRouteContext('report.vacation_liability', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString())

  try {
    const report = await generateVacationLiability(supabase, companyId, year)
    return NextResponse.json({ data: report })
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 })
  }
})
