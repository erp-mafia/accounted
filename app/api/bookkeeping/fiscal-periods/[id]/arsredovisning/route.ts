import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import { getAnnualReportCapabilities } from '@/lib/bokslut/arsredovisning/capabilities'

export const GET = withRouteContext(
  'period.arsredovisning_data',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      const model = await buildCanonicalAnnualReport(supabase, companyId, id, {
        stage: 'draft',
        includeIxbrl: false,
      })
      return NextResponse.json({
        data: model.report,
        compliance: {
          profile: model.profile,
          disclosures: model.disclosures,
          eligibility: model.eligibility,
          validation: model.validation,
          capabilities: getAnnualReportCapabilities(
            model.report.accounting_framework,
            model.eligibility,
            model.report.company?.entity_type ?? null,
          ),
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
)
