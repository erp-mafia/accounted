import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getPaymentsAvailability } from '@/lib/payments/orders/availability'

ensureInitialized()

/** GET /api/payments/availability: can this company pay through the bank, and from which accounts. */
export const GET = withRouteContext('payments.availability', async (_request, { supabase, companyId, user, log }) => {
  const availability = await getPaymentsAvailability({ supabase, companyId, userId: user.id, log })
  return NextResponse.json({ data: availability })
})
