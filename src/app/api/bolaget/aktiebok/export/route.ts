import { withRouteContext } from '@/lib/api/with-route-context'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { aktiebokCsv, type AktiebokCsvView } from '@/lib/bolaget/csv'
import { loadFullIdentity } from '@/lib/bolaget/people'
import { buildAktiebokPdfData } from '@/lib/bolaget/pdf-data'
import { renderAktiebokPdf } from '@/lib/bolaget/pdf'
import { loadRoles } from '@/lib/bolaget/roles'
import { bolagetGateResponse, callerIsCompanyAdmin, companyForPdf, operationContext } from '@/lib/bolaget/session'
import { loadShareRegisterData } from '@/lib/bolaget/share-register'
import { readAsOf } from '../../as-of'

const VIEWS: readonly AktiebokCsvView[] = ['shares', 'holders', 'history']

/**
 * GET /api/bolaget/aktiebok/export?format=pdf|csv&as_of=&view=: the
 * aktiebok printout as of a date with the full history appended (ABL 5:10,
 * 7:28), or CSV (view shares, holders or history). An owner or admin gets
 * the full personnummer the aktiebok must hold (5:5); everyone else masked.
 */
export const GET = withRouteContext('bolaget.aktiebok_export', async (request, ctx) => {
  const gate = await bolagetGateResponse(ctx, 'registers')
  if (gate) return gate
  const url = new URL(request.url)
  const format = url.searchParams.get('format') ?? 'pdf'
  const view = (url.searchParams.get('view') ?? 'shares') as AktiebokCsvView
  const asOf = readAsOf(request)
  if (asOf === null || (format !== 'pdf' && format !== 'csv') || !VIEWS.includes(view)) {
    return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
  }
  const op = operationContext(ctx)
  const [data, roles, company, isAdmin] = await Promise.all([
    loadShareRegisterData(op, asOf ?? null),
    loadRoles(op, asOf ?? null),
    companyForPdf(ctx.supabase, ctx.companyId),
    callerIsCompanyAdmin(ctx.supabase, ctx.user.id, ctx.companyId),
  ])
  const fullPersonnummer = isAdmin ? await loadFullIdentity(ctx.companyId, [...data.parties.keys()]) : undefined
  const printout = buildAktiebokPdfData(data, roles, company, { fullPersonnummer, generatedAt: todayIsoStockholm() })
  const name = `Aktiebok_${data.as_of}`
  if (format === 'csv') {
    return fileResponse(aktiebokCsv(printout, view), {
      filename: `${name}_${view}.csv`,
      contentType: 'text/csv; charset=utf-8',
      cacheControl: 'private, no-store',
    })
  }
  const pdf = await renderAktiebokPdf(printout)
  return fileResponse(new Uint8Array(pdf), { filename: `${name}.pdf`, contentType: 'application/pdf', cacheControl: 'private, no-store' })
})
