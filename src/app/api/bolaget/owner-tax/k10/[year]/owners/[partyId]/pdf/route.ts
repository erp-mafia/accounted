import { withRouteContext } from '@/lib/api/with-route-context'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { bolagetGateResponse, companyForPdf, operationContext } from '@/lib/bolaget/session'
import { loadK10Year } from '@/lib/bolaget/owner-tax/k10'
import { renderK10UnderlagPdf } from '@/lib/bolaget/owner-tax/pdf'
import { isUuid } from '@/lib/invariants/uuid'
import { parseIncomeYear } from '../../../../../year'

/**
 * GET /api/bolaget/owner-tax/k10/{year}/owners/{partyId}/pdf: the K10
 * underlag of one delägare as a PDF (every line with its source). Masked
 * identity only: the owner files K10 with their own personnummer.
 */
export const GET = withRouteContext<{ params: Promise<{ year: string; partyId: string }> }>('bolaget.k10_pdf', async (_request, ctx, { params }) => {
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  const { year: rawYear, partyId } = await params
  const year = parseIncomeYear(rawYear)
  if (year === null || !isUuid(partyId)) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
  const [view, company] = await Promise.all([loadK10Year(operationContext(ctx), year), companyForPdf(ctx.supabase, ctx.companyId)])
  if (!view.supported) return errorResponseFromCode('K10_YEAR_UNSUPPORTED', ctx.log, { requestId: ctx.requestId })
  const owner = view.owners.find((o) => o.party_id === partyId)
  if (!owner) return errorResponseFromCode('K10_OWNER_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
  const pdf = await renderK10UnderlagPdf({ company, year: view, owner, generated_at: todayIsoStockholm() })
  const name = owner.name.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'agare'
  return fileResponse(new Uint8Array(pdf), { filename: `K10-underlag_${year}_${name}.pdf`, contentType: 'application/pdf', cacheControl: 'private, no-store' })
})
