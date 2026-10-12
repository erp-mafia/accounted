import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { resolvePaymentOrder } from '@/lib/payments/orders/lifecycle'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'

const ResolveSchema = z.discriminatedUnion('resolution', [
  /** The payment never reached the bank, or the bank no longer has it. */
  z.object({ resolution: z.literal('not_at_bank') }),
  /** The bank paid it: the payment row on the invoice that booked the debit. */
  z.object({ resolution: z.literal('paid'), supplier_invoice_payment_id: z.uuid() }),
])

/**
 * POST /api/payments/orders/:id/resolve: a person settles a bank payment the
 * bank cannot settle (its outcome unknown, or the bank cannot be asked about
 * it). Session only, behind MFA: an agent never resolves a payment.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'payment_orders.resolve',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, ResolveSchema)
    if (!validation.success) return validation.response
    const signer = signerFromRequest(request, null)
    const outcome = await resolvePaymentOrder(
      { supabase, companyId, userId: user.id, log },
      {
        orderId: id,
        resolution: validation.data.resolution,
        supplierInvoicePaymentId: validation.data.resolution === 'paid' ? validation.data.supplier_invoice_payment_id : undefined,
        signer: { ipAddress: signer.ipAddress, userAgent: signer.userAgent },
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
