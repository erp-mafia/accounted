import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateShiftPremiumRuleSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { deleteShiftPremiumRule, updateShiftPremiumRule } from '@/lib/salary/shift-premium-rules'

ensureInitialized()

/** PATCH merges the body with the stored row before the scope check (all
 * employees XOR named employees), so a one-field patch cannot leave a rule
 * that applies to nobody. DELETE is a hard delete: rules are configuration,
 * derived lines are regenerated per calculation and booked runs are immutable. */
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
