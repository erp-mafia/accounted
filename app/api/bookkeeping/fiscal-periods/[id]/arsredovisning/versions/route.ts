import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'
import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import {
  createAnnualReportVersion,
  hasStatementIntegrityErrors,
  listAnnualReportVersions,
} from '@/lib/bokslut/arsredovisning/version-service'

const PostSchema = z
  .object({
    action: z.enum(['snapshot', 'finalize']),
    certificate_signer: z
      .object({
        first_name: z.string().min(1).max(100),
        last_name: z.string().min(1).max(100),
        role: z.enum([
          'Styrelseledamot',
          'Styrelseordförande',
          'VD',
          'Verkställande direktör',
        ]),
      })
      .strict()
      .optional(),
  })
  .strict()

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

export const POST = withRouteContext(
  'period.arsredovisning_versions_create',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, PostSchema)
    if (!validation.success) return validation.response
    try {
      if (!(await ownsPeriod(supabase, companyId, id))) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      const signer = validation.data.certificate_signer
      const model = await buildCanonicalAnnualReport(supabase, companyId, id, {
        stage: validation.data.action === 'finalize' ? 'signing' : 'draft',
        undertecknare: signer
          ? {
              firstName: signer.first_name,
              lastName: signer.last_name,
              role: signer.role,
            }
          : undefined,
      })
      if (hasStatementIntegrityErrors(model)) {
        return errorResponseFromCode('ARSREDOVISNING_INCOMPLETE', log, {
          requestId,
          details: model.validation,
        })
      }
      if (validation.data.action === 'finalize' && !model.validation.ok) {
        return errorResponseFromCode('ARSREDOVISNING_INCOMPLETE', log, {
          requestId,
          details: model.validation,
        })
      }
      const data = await createAnnualReportVersion(
        validation.data.action === 'finalize' ? createServiceClient() : supabase,
        user.id,
        model,
        validation.data.action === 'finalize',
      )
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
