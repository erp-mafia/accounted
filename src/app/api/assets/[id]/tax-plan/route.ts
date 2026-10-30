import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { TaxPlanSchema, setAssetTaxPlan } from '@/lib/bokslut/assets/building-tax-service'

type Params = { params: Promise<{ id: string }> }

/**
 * State the tax depreciation plan of a building or markanläggning (IL 19
 * kap. 5-5 a §§, 20 kap. 5 §): the percentage a year, the day it starts and
 * the primäravdrag. It drives INK2S 4.9 and the K3 deferred tax; a null rate
 * clears it.
 */
export const PUT = withRouteContext<Params>(
  'assets.tax_plan.update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, TaxPlanSchema)
    if (!validation.success) return validation.response
    try {
      const asset = await setAssetTaxPlan(supabase, companyId, id, validation.data)
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
