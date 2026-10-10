import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { approvePaymentOrders } from '@/lib/payments/orders/lifecycle'

ensureInitialized()

const ApproveSchema = z.object({
  order_ids: z.array(z.uuid()).min(1).max(100),
  /**
   * The invoices whose account a person checked: required for every order to
   * an account that is new for the supplier or differs from the supplier card.
   */
  confirmed_payee_invoice_ids: z.array(z.uuid()).max(100).optional(),
})

/** POST /api/payments/orders/approve: attest draft bank payments (draft -> approved). */
export const POST = withRouteContext(
  'payment_orders.approve',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, ApproveSchema)
    if (!validation.success) return validation.response
    const outcome = await approvePaymentOrders(
      { supabase, companyId, userId: user.id, log },
      { orderIds: validation.data.order_ids, confirmedPayeeInvoiceIds: validation.data.confirmed_payee_invoice_ids },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
