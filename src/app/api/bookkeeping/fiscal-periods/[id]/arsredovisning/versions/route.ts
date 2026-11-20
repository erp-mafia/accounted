import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { listAnnualReportVersions } from '@/lib/bokslut/arsredovisning/version-service'
import { VersionCreateSchema } from '@/lib/bokslut/arsredovisning/workflow-schemas'
import { createArsredovisningVersion } from '@/lib/bokslut/arsredovisning/workflow-service'
import { sessionFailureResponse } from '@/lib/operations/session'

async function ownsPeriod(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()
  return Boolean(data)
}

export const GET = withRouteContext(
  'period.arsredovisning_versions_list',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      if (!(await ownsPeriod(supabase, companyId, id))) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      const data = await listAnnualReportVersions(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
)

/**
 * Freeze a version. The rules (a complete import-free read, statements that
 * tie, signing-stage checks for finalize, the service-role finalize RPC) live
 * in workflow-service.ts, shared with operation arsredovisning.create-version.
 */
export const POST = withRouteContext(
  'period.arsredovisning_versions_create',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, VersionCreateSchema)
    if (!validation.success) return validation.response
    const outcome = await createArsredovisningVersion(
      { supabase, companyId, userId: user.id, log },
      id,
      validation.data,
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
