import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isUsagePeriod } from '@/lib/payments/usage'
import { createServiceClient } from '@/lib/supabase/server'
import { getCompanyUsage } from '@/lib/usage/summary'

/**
 * GET /api/billing/usage?period=YYYY-MM: the company's use of each priced
 * service in a month (this month by default), against what the month
 * includes, and whether units above it are billed. Every member reads it.
 * Counted with the service role and the resolved company, so the numbers do
 * not depend on which tables the viewer's role reaches (lib/usage/summary.ts).
 */
export const GET = withRouteContext('billing.usage', async (request, { companyId }) => {
  const period = new URL(request.url).searchParams.get('period')
  const usage = await getCompanyUsage(createServiceClient(), companyId, isUsagePeriod(period) ? period : undefined)
  return NextResponse.json({ data: usage })
})
