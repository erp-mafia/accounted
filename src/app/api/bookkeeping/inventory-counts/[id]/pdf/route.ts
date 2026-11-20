import { withRouteContext } from '@/lib/api/with-route-context'
import { fileResponse } from '@/lib/api/file-response'
import { stockCountEnabledFor } from '@/lib/env/stock-count-switch'
import { getStockCount, renderStockCountPdfFor } from '@/lib/bokslut/stock-count/signing'
import { stockCountPdfFilename } from '@/lib/bokslut/stock-count/pdf'
import { stockCountDisabledResponse, stockCountErrorResponse } from '@/lib/bokslut/stock-count/route-errors'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/bookkeeping/inventory-counts/[id]/pdf: the inventeringslista as a
 * PDF with the "på heder och samvete" statement, to print and sign by hand
 * (a signed count prints who signed and when).
 */
export const GET = withRouteContext<Params>('bookkeeping.inventory-counts.pdf', async (_request, ctx, { params }) => {
  if (!stockCountEnabledFor(ctx.companyId)) return stockCountDisabledResponse(ctx)
  const { id } = await params
  try {
    const count = await getStockCount(ctx.supabase, ctx.companyId, ctx.user.id, id)
    const pdf = await renderStockCountPdfFor(ctx.supabase, ctx.companyId, count)
    return fileResponse(new Uint8Array(pdf), { filename: stockCountPdfFilename(count.balance_date), contentType: 'application/pdf' })
  } catch (err) {
    const response = stockCountErrorResponse(err, ctx)
    if (response) return response
    throw err
  }
})
