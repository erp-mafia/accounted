import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getBankPaymentsUsage, isUsagePeriod } from '@/lib/payments/usage'

/** GET /api/payments/usage?period=YYYY-MM: bank payments sent and accounts used this month, against what the plan includes. */
export const GET = withRouteContext('payments.usage', async (request, { supabase, companyId }) => {
  const period = new URL(request.url).searchParams.get('period')
  const usage = await getBankPaymentsUsage(supabase, companyId, isUsagePeriod(period) ? period : undefined)
  return NextResponse.json({ data: usage })
})
