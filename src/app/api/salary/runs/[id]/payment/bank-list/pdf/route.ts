import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { contentDisposition } from '@/lib/api/content-disposition'
import {
  buildSalaryBankList,
  SalaryBankListQuery,
  salaryBankListErrorResponse,
  salaryBankListFileName,
} from '@/lib/salary/payment/bank-list'
import { SalaryBankListPDF } from '@/lib/salary/pdf/bank-list-template'

/**
 * GET /api/salary/runs/{id}/payment/bank-list/pdf?format=pain001|bg_lb
 *
 * The banklista as a PDF, in the Lönesammanställning look. Same data as the
 * JSON route: the payment file builder's own payee lines, from a dry run.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.payment.bank_list.pdf',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const query = validateQuery(request, SalaryBankListQuery)
    if (!query.success) return query.response

    const result = await buildSalaryBankList(supabase, {
      companyId,
      runId: id,
      userId: user.id,
      format: query.data.format,
    })
    if (!result.ok) return salaryBankListErrorResponse(result, log, requestId)

    const buffer = await renderToBuffer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SalaryBankListPDF({ list: result.list, generatedAt: new Date().toISOString() }) as any,
    )

    return new Response(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('inline', salaryBankListFileName(result.list)),
      },
    })
  },
)
