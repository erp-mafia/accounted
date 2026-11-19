import { withRouteContext } from '@/lib/api/with-route-context'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { bolagetGateResponse, companyForPdf, operationContext } from '@/lib/bolaget/session'
import { loadOwnerLoansView, specialList } from '@/lib/bolaget/owner-tax/loans-view'
import { renderSpecialListPdf } from '@/lib/bolaget/owner-tax/pdf'
import { parseIncomeYear } from '../../year'

/**
 * GET /api/bolaget/owner-tax/special-list/{year}: the special list of loans
 * and security granted under the business-loan exception or a dispensation
 * that were owed in the year (ABL 21:10), as a PDF to keep ten years.
 */
export const GET = withRouteContext<{ params: Promise<{ year: string }> }>('bolaget.loan_special_list', async (_request, ctx, { params }) => {
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  const year = parseIncomeYear((await params).year)
  if (year === null) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
  const [view, company] = await Promise.all([loadOwnerLoansView(operationContext(ctx)), companyForPdf(ctx.supabase, ctx.companyId)])
  const pdf = await renderSpecialListPdf({ company, year, rows: specialList(view, year), generated_at: todayIsoStockholm() })
  return fileResponse(new Uint8Array(pdf), { filename: `Sarskild_forteckning_lan_${year}.pdf`, contentType: 'application/pdf', cacheControl: 'private, no-store' })
})
