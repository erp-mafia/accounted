import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { VacationLiabilityReconcileSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { operationPreviewToken } from '@/lib/operations/preview-token'
import { sessionFailureResponse } from '@/lib/operations/session'
import { salaryVacationLiabilityReconcile } from '@/lib/operations/salary-vacation-liability'

/**
 * POST /api/salary/vacation-liability/reconcile
 *
 * Stäm av semesterlöneskuld per datum: the Semesterskuld report's confirm
 * dialog. `dry_run: true` answers the verifikat it would book (lines,
 * per-employee figures) with a preview_token; the commit sends the token
 * back and is refused with 409 PREVIEW_STALE when the books moved since, so
 * what posts is what the dialog showed. The same operation as the v1 door
 * (salary.vacation-liability.reconcile); refusals are its codes, a locked
 * period is PERIOD_LOCKED.
 */
export const POST = withRouteContext(
  'salary.vacation_liability.reconcile',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, VacationLiabilityReconcileSchema)
    if (!validation.success) return validation.response
    const { as_of, dry_run, preview_token } = validation.data
    const op = salaryVacationLiabilityReconcile
    const input = { as_of }
    const ctx = { supabase, companyId, userId: user.id, log }

    if (dry_run || preview_token) {
      const dry = await op.run(ctx, input, { dryRun: true })
      if (!dry.ok) return sessionFailureResponse(dry, log, requestId)
      if (!dry.dryRun) throw new Error('reconcile dry run answered a commit')
      const token = operationPreviewToken(op, companyId, input, dry.preview)
      if (dry_run) return NextResponse.json({ data: { preview: dry.preview, preview_token: token } })
      if (token !== preview_token) {
        return errorResponseFromCode('PREVIEW_STALE', log, {
          requestId,
          details: { preview: dry.preview, preview_token: token },
        })
      }
    }

    const outcome = await op.run(ctx, input, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('reconcile commit answered a dry run')
    return NextResponse.json({ data: outcome.data, ...(outcome.warnings ? { warnings: outcome.warnings } : {}) })
  },
  { requireWrite: true },
)
