import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { buildSalaryBankList, SalaryBankListQuery, salaryBankListErrorResponse } from '@/lib/salary/payment/bank-list'

/**
 * GET /api/salary/runs/{id}/payment/bank-list?format=pain001|bg_lb
 *
 * Banklista: the payments the salary payment file for this run carries
 * (payee, masked account, amount, file reference) and their total, shown
 * beside the download so the file can be checked before it goes to the bank.
 * Computed by the payment file builder itself as a dry run: nothing is
 * archived and the run is not stamped. Refused with the builder's reason when
 * the file could not be created either.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.payment.bank_list',
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

    return NextResponse.json({ data: result.list })
  },
)
