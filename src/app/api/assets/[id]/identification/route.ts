import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { AssetIdentificationSchema, updateAssetIdentification } from '@/lib/bokslut/assets/identification'

/**
 * PATCH /api/assets/:id/identification: a building's fastighetsbeteckning
 * and taxeringsvärde, a vehicle's registration number and bilförmån. Never
 * part of the depreciation basis. Behind the Bolaget rollout.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'assets.identification.update',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, AssetIdentificationSchema)
    if (!validation.success) return validation.response
    const outcome = await updateAssetIdentification({ supabase, companyId }, id, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
