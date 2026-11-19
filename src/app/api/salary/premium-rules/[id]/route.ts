import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateShiftPremiumRuleSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { deleteShiftPremiumRule, updateShiftPremiumRule } from '@/lib/salary/shift-premium-rules'

/**
 * PATCH merges the body with the stored row before checking the scope pair,
 * the amount field of the form and the validity order, so a one-field patch
 * cannot leave a rule that applies to nobody or carries two amounts. Sending
 * amount_form switches the form.
 *
 * DELETE removes a rule nothing derives from. A rule a payslip line already
 * derives from is kept and switched off (deleted=false, deactivated=true), so
 * the line keeps the rule it was paid under.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.premium-rules.update',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, UpdateShiftPremiumRuleSchema)
    if (!validation.success) return validation.response

    const result = await updateShiftPremiumRule(supabase, {
      companyId,
      ruleId: id,
      input: validation.data,
    })
    if (!result.ok) {
      return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    }
    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.premium-rules.delete',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const result = await deleteShiftPremiumRule(supabase, { companyId, ruleId: id })
    if (!result.ok) {
      return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    }
    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)
