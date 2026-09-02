import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateInvoiceFromSalesOrderSchema } from '@/lib/api/schemas'
import { createInvoiceFromSalesOrder } from '@/lib/sales-orders/create-invoice-from-order'
import { serviceFailureResponse } from '@/lib/sales-orders/respond'

ensureInitialized()

/**
 * POST /api/sales-orders/[id]/create-invoice: create an unnumbered DRAFT
 * kundfaktura for the picked (or remaining / delivered) order lines. The
 * user reviews and sends it through the normal invoice flow, which books
 * it. Partial invoicing is the point: call again for the rest.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'sales_order.create_invoice',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, CreateInvoiceFromSalesOrderSchema, {
      log,
      operation: 'sales_order.create_invoice',
    })
    if (!validation.success) return validation.response

    const result = await createInvoiceFromSalesOrder(supabase, {
      companyId,
      userId: user.id,
      orderId: id,
      input: validation.data,
    })
    if (!result.ok) return serviceFailureResponse(result, log, requestId)

    try {
      await eventBus.emit({
        type: 'invoice.created',
        payload: { invoice: result.invoice, userId: user.id, companyId },
      })
    } catch {
      // Non-critical
    }

    return NextResponse.json(
      { data: { invoice: result.invoice, order: result.order }, invoice_id: result.invoice.id },
      { status: 201 },
    )
  },
  { requireWrite: true },
)
