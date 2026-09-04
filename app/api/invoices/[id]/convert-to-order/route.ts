import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { convertProformaToSalesOrder } from '@/lib/sales-orders/convert-proforma'
import { serviceFailureResponse } from '@/lib/sales-orders/respond'

ensureInitialized()

/**
 * POST /api/invoices/[id]/convert-to-order: proforma -> draft kundorder.
 * Sibling of /convert (proforma -> invoice): copies the lines into a new
 * order and marks the proforma cancelled.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.convert_to_order',
  async (_request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const result = await convertProformaToSalesOrder(supabase, { companyId, userId: user.id, invoiceId: id })
    if (!result.ok) return serviceFailureResponse(result, log, requestId)
    return NextResponse.json({ data: result.order, sales_order_id: result.order.id }, { status: 201 })
  },
  { requireWrite: true },
)
