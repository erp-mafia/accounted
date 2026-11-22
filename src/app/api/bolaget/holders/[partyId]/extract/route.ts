import { withRouteContext } from '@/lib/api/with-route-context'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { loadFullIdentity } from '@/lib/bolaget/people'
import { buildHolderExtractData } from '@/lib/bolaget/pdf-data'
import { renderHolderExtractPdf } from '@/lib/bolaget/pdf'
import { bolagetGateResponse, callerIsCompanyAdmin, companyForPdf, operationContext } from '@/lib/bolaget/session'
import { loadShareRegisterData } from '@/lib/bolaget/share-register'
import { readAsOf } from '../../../as-of'

/**
 * GET /api/bolaget/holders/{partyId}/extract?as_of=: one holder's extract
 * of the aktiebok as a PDF: their shares on the date and every entry that
 * names them. 404 for a party the register does not name.
 */
export const GET = withRouteContext<{ params: Promise<{ partyId: string }> }>('bolaget.holder_extract', async (request, ctx, { params }) => {
  const { partyId } = await params
  const gate = await bolagetGateResponse(ctx, 'registers')
  if (gate) return gate
  const asOf = readAsOf(request)
  if (asOf === null) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, details: { field: 'as_of' } })
  const op = operationContext(ctx)
  const [data, company, isAdmin] = await Promise.all([
    loadShareRegisterData(op, asOf ?? null),
    companyForPdf(ctx.supabase, ctx.companyId),
    callerIsCompanyAdmin(ctx.supabase, ctx.user.id, ctx.companyId),
  ])
  const fullPersonnummer = isAdmin ? await loadFullIdentity(ctx.companyId, [partyId]) : undefined
  const extract = buildHolderExtractData(data, partyId, company, { fullPersonnummer, generatedAt: todayIsoStockholm() })
  if (!extract) return errorResponseFromCode('BOLAGET_PARTY_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
  const pdf = await renderHolderExtractPdf(extract)
  const safeName = extract.holder.name.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return fileResponse(new Uint8Array(pdf), { filename: `Aktiebok_utdrag_${safeName}_${data.as_of}.pdf`, contentType: 'application/pdf', cacheControl: 'private, no-store' })
})
