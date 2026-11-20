import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateShiftPremiumRuleSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createShiftPremiumRule, listShiftPremiumRules } from '@/lib/salary/shift-premium-rules'

/**
 * OB / overtime premium rules for the active company.
 *
 * GET  ?include_inactive=true lists switched-off rules too (default: active
 *      only, which is exactly the set the salary engine loads).
 * POST creates a rule. Every named employee must belong to the company, and
 *      a monthly_divisor rule names no hourly-paid employee.
 */
export const GET = withRouteContext(
  'salary.premium-rules.list',
  async (request, { supabase, companyId, log, requestId }) => {
    const includeInactive = new URL(request.url).searchParams.get('include_inactive') === 'true'
    const result = await listShiftPremiumRules(supabase, { companyId, includeInactive })
    if (!result.ok) {
      return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    }
    return NextResponse.json({ data: result.data })
  },
)

export const POST = withRouteContext(
  'salary.premium-rules.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateShiftPremiumRuleSchema)
    if (!validation.success) return validation.response

    const result = await createShiftPremiumRule(supabase, {
      companyId,
      userId: user.id,
      input: validation.data,
    })
    if (!result.ok) {
      return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    }
    return NextResponse.json({ data: result.data }, { status: 201 })
  },
  { requireWrite: true },
)
