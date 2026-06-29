import { NextResponse } from 'next/server'
import { generateSIEExport, encodeSIEToCP437 } from '@/lib/reports/sie-export'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

export const GET = withRouteContext(
  'report.sie_export',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')
    const excludeClosing = searchParams.get('exclude_closing') === 'true'
    const useCP437 = searchParams.get('encoding') === 'cp437'

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }

    const opLog = log.child({ periodId })

    const { data: company } = await supabase
      .from('company_settings')
      .select('company_name, org_number')
      .eq('company_id', companyId)
      .single()

    if (!company) {
      return errorResponseFromCode('SIE_EXPORT_COMPANY_NOT_FOUND', opLog, { requestId })
    }

    try {
      const sieContent = await generateSIEExport(supabase, companyId!, {
        fiscal_period_id: periodId,
        company_name: company.company_name || 'Unknown',
        org_number: company.org_number,
        exclude_year_end_closing: excludeClosing,
        emit_format_pc8: useCP437,
      })

      const body = useCP437 ? Buffer.from(encodeSIEToCP437(sieContent)) : sieContent
      const contentType = useCP437 ? 'application/octet-stream' : 'text/plain; charset=utf-8'

      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="export_${periodId}.se"`,
          'X-Request-Id': requestId,
        },
      })
    } catch (err) {
      opLog.error('sie export generation failed', err as Error)
      return errorResponseFromCode('SIE_EXPORT_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
)
