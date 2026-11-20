import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { dbError } from '@/lib/errors/db-error'
import { generateForaMonthlyReport } from '@/lib/salary/fora/monthly-report'

const ForaReportQuerySchema = z.object({
  year: z.coerce.number().int().min(2024).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  download: z.enum(['1']).optional(),
})

/**
 * GET /api/salary/fora?year=YYYY&month=M[&download=1]
 *
 * Fora's monthly report for a payment month (lib/salary/fora/monthly-report.ts):
 * the summary the salary run page shows before the download, or with
 * download=1 the JSON file the employer uploads on Fora's Mina sidor. A pure
 * read: Fora replaces a month when the file is sent again, so nothing is
 * stored. v1 and MCP read the same service (operation salary-runs.fora-report.get)
 * but get the summary only.
 */
export const GET = withRouteContext('salary.fora.monthly', async (request, { supabase, companyId, log, requestId }) => {
  const query = validateQuery(request, ForaReportQuerySchema)
  if (!query.success) return query.response
  const { year, month, download } = query.data

  const result = await generateForaMonthlyReport(supabase, { companyId: companyId!, year, month })
  if (!result.ok) {
    if (result.code === 'FORA_REPORT_INCOMPLETE') {
      return errorResponseFromCode('FORA_REPORT_INCOMPLETE', log, { requestId, details: { issues: result.issues } })
    }
    if (result.code === 'COMPANY_NOT_FOUND') return errorResponseFromCode('COMPANY_NOT_FOUND', log, { requestId })
    return errorResponse(dbError(result.cause), log, { requestId })
  }

  const { file, ...report } = result.data
  if (download) {
    // UTF-8 JSON, Fora's encoding (spec 4.5). The name is built from digits only.
    return fileResponse(JSON.stringify(file, null, 2), {
      filename: report.filename,
      contentType: 'application/json; charset=utf-8',
    })
  }
  return NextResponse.json({ data: { ...report, employee_count: report.payrolls.length } })
})
