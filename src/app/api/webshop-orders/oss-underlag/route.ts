import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { OssUnderlagQuerySchema } from '@/lib/api/schemas'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getOssUnderlag } from '@/lib/webshop-orders/oss-underlag'

/**
 * GET /api/webshop-orders/oss-underlag?year=2026&quarter=3
 *
 * The OSS underlag for a calendar quarter, the same answer as
 * GET /api/v1/companies/{companyId}/webshop-orders/oss-underlag.
 */
export const GET = withRouteContext('webshop_orders.oss_underlag', async (request, { supabase, companyId, user, log, requestId }) => {
  const query = validateQuery(request, OssUnderlagQuerySchema)
  if (!query.success) return query.response

  const outcome = await getOssUnderlag({ supabase, companyId, userId: user.id, log }, query.data)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  return NextResponse.json({ data: outcome.data })
})
