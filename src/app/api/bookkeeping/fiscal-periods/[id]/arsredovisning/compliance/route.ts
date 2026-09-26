import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import { ComplianceUpdateSchema } from '@/lib/bokslut/arsredovisning/workflow-schemas'
import {
  complianceResponseData,
  updateArsredovisningCompliance,
} from '@/lib/bokslut/arsredovisning/workflow-service'
import { sessionFailureResponse } from '@/lib/operations/session'

export const GET = withRouteContext(
  'period.arsredovisning_compliance_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      const model = await buildCanonicalAnnualReport(supabase, companyId, id, {
        stage: 'draft',
        includeIxbrl: false,
      })
      return NextResponse.json({ data: complianceResponseData(model) })
    } catch (err) {
      // No periodExists preflight here: buildArsredovisningData applies the
      // same company_id filter and throws 'Fiscal period not found' for
      // missing/foreign periods, so mapping that message (mirroring the data
      // route) yields the identical 404 envelope without the extra round
      // trip. PATCH keeps the preflight (in the service) since it guards the
      // profile upsert before any write.
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
)

/** Rules in workflow-service.ts, shared with operation arsredovisning.update-compliance. */
export const PATCH = withRouteContext(
  'period.arsredovisning_compliance_patch',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, ComplianceUpdateSchema)
    if (!validation.success) return validation.response
    const outcome = await updateArsredovisningCompliance(
      { supabase, companyId, userId: user.id, log },
      id,
      validation.data,
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
