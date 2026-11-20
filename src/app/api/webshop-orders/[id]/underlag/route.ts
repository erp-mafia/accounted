import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { contentDisposition } from '@/lib/api/content-disposition'
import { privateNoStore } from '@/lib/api/private-no-store'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { loadWebshopOrder } from '@/lib/webshop-orders/book-order'
import { ensureWebshopOrderUnderlag } from '@/lib/webshop-orders/ensure-order-underlag'

/**
 * GET /api/webshop-orders/[id]/underlag
 *
 * The orderunderlag PDF for one order row, rendered on the fly with the same
 * renderer booking archives with (lib/webshop-orders/order-underlag), so the
 * booking dialog can show what will land on the verifikat before anything is
 * booked. Reads only; nothing is stored. Refused while a non-SEK row has no
 * SEK conversion: the booking dialog blocks the same rows.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'webshop_order.underlag.preview',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const order = await loadWebshopOrder(supabase, companyId, id)
    if (!order) {
      return privateNoStore(errorResponseFromCode('WEBSHOP_ORDER_NOT_FOUND', log, { requestId }))
    }
    if (!isKronorCurrency(order.currency) && order.total_sek === null) {
      return privateNoStore(
        errorResponseFromCode('WEBSHOP_ORDER_FX_UNRESOLVED', log, {
          requestId,
          details: { currency: order.currency },
        }),
      )
    }

    try {
      // Imported here so react-pdf loads only when a PDF is asked for.
      const { renderWebshopOrderUnderlagPdf } = await import('@/lib/webshop-orders/order-underlag')
      const { bytes, filename } = await renderWebshopOrderUnderlagPdf({ supabase, companyId, order })
      return new Response(bytes, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': contentDisposition('inline', filename),
          'Cache-Control': 'private, no-store',
        },
      })
    } catch (error) {
      log.error('order underlag preview render failed', error as Error, { orderId: id })
      return privateNoStore(errorResponseFromCode('WEBSHOP_ORDER_UNDERLAG_FAILED', log, { requestId }))
    }
  },
)

/**
 * POST /api/webshop-orders/[id]/underlag
 *
 * Retry for a booked order whose verifikat ended up without its
 * orderunderlag (booking never fails on the PDF). Archives it only when it
 * is missing, so a repeat answers already_attached instead of filing a
 * second copy. Attaches a document; the posted entry itself is untouched.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'webshop_order.underlag.archive',
  async (_request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const outcome = await ensureWebshopOrderUnderlag(supabase, companyId, user.id, id, log)

    if (!outcome.ok) {
      switch (outcome.kind) {
        case 'not_found':
          return errorResponseFromCode('WEBSHOP_ORDER_NOT_FOUND', log, { requestId })
        case 'not_booked':
          return errorResponseFromCode('WEBSHOP_ORDER_NOT_BOOKED', log, { requestId })
        case 'failed':
          return errorResponseFromCode('WEBSHOP_ORDER_UNDERLAG_FAILED', log, {
            requestId,
            details: { journal_entry_id: outcome.journalEntryId },
          })
      }
    }

    return NextResponse.json({
      data: {
        journal_entry_id: outcome.journalEntryId,
        document_id: outcome.documentId,
        already_attached: outcome.alreadyAttached,
      },
    })
  },
  { requireWrite: true },
)
