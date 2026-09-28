import { withRouteContext } from '@/lib/api/with-route-context'
import { renderToBuffer } from '@react-pdf/renderer'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildSalaryRunUnderlag, salaryRunUnderlagFileName } from '@/lib/salary/run-underlag'
import { SalaryRunUnderlagPDF } from '@/lib/salary/pdf/run-underlag-template'
import { contentDisposition } from '@/lib/api/content-disposition'

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = await renderToBuffer(SalaryRunUnderlagPDF({ data: result.data }) as any)

    return new Response(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('inline', salaryRunUnderlagFileName(result.data)),
      },
    })
  },
)
