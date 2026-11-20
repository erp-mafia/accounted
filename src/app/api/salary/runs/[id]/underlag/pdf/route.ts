import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildSalaryRunUnderlag, salaryRunUnderlagFileName } from '@/lib/salary/run-underlag'
import { fileResponse } from '@/lib/api/file-response'

/**
 * Lönesammanställning PDF: the bokföringsunderlag of one booked salary run
 * (per-employee figures plus the posted verifikat). Read-only; available for
 * booked and corrected runs.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.underlag.pdf',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const result = await buildSalaryRunUnderlag(supabase, companyId, id)
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId })

    const [{ renderToBuffer }, { SalaryRunUnderlagPDF }] = await Promise.all([
      import('@react-pdf/renderer'),
      import('@/lib/salary/pdf/run-underlag-template'),
    ])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = await renderToBuffer(SalaryRunUnderlagPDF({ data: result.data }) as any)

    return fileResponse(buffer as unknown as BodyInit, {
      filename: salaryRunUnderlagFileName(result.data),
      contentType: 'application/pdf',
      disposition: 'inline',
    })
  },
)
