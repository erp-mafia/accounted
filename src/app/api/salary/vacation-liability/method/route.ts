import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { VacationLiabilityMethodSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { computePreviewToken } from '@/lib/operations/preview-token'
import { sessionFailureResponse } from '@/lib/operations/session'
import { readVacationLiabilityMethod, setVacationLiabilityMethod } from '@/lib/salary/vacation-liability-reconcile'

/** The pin's operation name: this door's own, never shared with another. */
const PIN_OPERATION = 'salary.vacation-liability.method'

/**
 * GET /api/salary/vacation-liability/method: how the company books the
 * semesterlöneskuld (salary_vacation_liability_method).
 */
export const GET = withRouteContext('salary.vacation_liability.method', async (_request, { supabase, companyId, log, requestId }) => {
  try {
    return NextResponse.json({ data: { method: await readVacationLiabilityMethod(supabase, companyId) } })
  } catch (err) {
    return errorResponse(err, log, { requestId })
  }
})

/**
 * POST /api/salary/vacation-liability/method
 *
 * The salary settings row "Semesterlöneskuld". `dry_run: true` answers what
 * the change does: to 'remeasure' the catch-up verifikat as of today (the
 * confirm dialog shows its amount, date and lines) with a preview_token; the
 * commit sends the token back and is refused with 409 PREVIEW_STALE when the
 * books moved since. The catch-up posts first, then the setting changes
 * (setVacationLiabilityMethod). Owner or admin: company_settings is admin
 * written (RLS), so the route asks the same predicate.
 */
export const POST = withRouteContext(
  'salary.vacation_liability.method',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, VacationLiabilityMethodSchema)
    if (!validation.success) return validation.response
    const { method, dry_run, preview_token } = validation.data
    const ctx = { supabase, companyId, userId: user.id, log }

    if (dry_run || preview_token) {
      const dry = await setVacationLiabilityMethod(ctx, { method }, { dryRun: true })
      if (!dry.ok) return sessionFailureResponse(dry, log, requestId)
      if (!dry.dryRun) throw new Error('method dry run answered a commit')
      const token = computePreviewToken({ operationId: PIN_OPERATION, companyId, input: { method }, preview: dry.preview })
      if (dry_run) return NextResponse.json({ data: { preview: dry.preview, preview_token: token } })
      if (token !== preview_token) {
        return errorResponseFromCode('PREVIEW_STALE', log, {
          requestId,
          details: { preview: dry.preview, preview_token: token },
        })
      }
    }

    const outcome = await setVacationLiabilityMethod(ctx, { method }, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('method commit answered a dry run')
    return NextResponse.json({ data: outcome.data })
  },
  { requireAdmin: true },
)
