import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { listCarBenefits } from '@/lib/bokslut/assets/identification'

/** GET /api/assets/car-benefits: the bilförmåner a vehicle in the register can be linked to. Behind the Bolaget rollout. */
export const GET = withRouteContext('assets.car-benefits.list', async (_request, { supabase, companyId, log, requestId }) => {
  const outcome = await listCarBenefits({ supabase, companyId })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
