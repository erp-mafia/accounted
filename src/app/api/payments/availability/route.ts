import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getPaymentsReadiness } from '@/lib/payments/orders/availability'

/**
 * GET /api/payments/availability: can this company pay through the bank,
 * from which accounts, where its verification stands, and what stands
 * between it and a signed payment (readiness, lib/payments/orders/readiness).
 */
export const GET = withRouteContext('payments.availability', async (_request, { supabase, companyId, user, log }) => {
  const readiness = await getPaymentsReadiness({ supabase, companyId, userId: user.id, log })
  return NextResponse.json({ data: readiness })
})
