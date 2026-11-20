import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import {
  DevelopmentModelSchema,
  getDevelopmentModel,
  setDevelopmentModel,
} from '@/lib/bokslut/assets/development-model'

/**
 * The company's accounting policies the books depend on: today the model
 * for internally generated intangible assets under K3 (punkt 18.7).
 */
export const GET = withRouteContext('company.accounting_policies.get', async (_request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    const { model } = await getDevelopmentModel(supabase, companyId)
    return NextResponse.json({ data: { development_expenditure_model: model } })
  } catch (err) {
    return errorResponse(err, log, { requestId })
  }
})

/**
 * Choose the model. set_development_expenditure_model writes it for an owner
 * or admin and records the change in audit_log, so the route asks for an
 * admin.
 */
export const PATCH = withRouteContext(
  'company.accounting_policies.update',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, DevelopmentModelSchema)
    if (!validation.success) return validation.response
    try {
      const model = await setDevelopmentModel(supabase, companyId, validation.data.development_expenditure_model, {
        userId: user.id,
      })
      return NextResponse.json({ data: { development_expenditure_model: model } })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireAdmin: true },
)
