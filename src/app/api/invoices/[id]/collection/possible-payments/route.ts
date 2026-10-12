import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { dismissPossiblePayment } from '@/lib/collections/bank-sweep'
import { loadInvoiceCase } from '@/lib/collections/invoice-collection'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

const ParamsSchema = z.object({ id: z.uuid() })

const PossiblePaymentBodySchema = z.object({
  hit_id: z.uuid(),
  /** dismiss: the bank row pays something else, not this invoice. */
  action: z.literal('dismiss'),
})

/**
 * POST /api/invoices/[id]/collection/possible-payments: a person's answer to
 * a bank row the payment-candidate sweep found for an invoice under
 * collection: it pays something else. (Booking the row answers it too.) The
 * case stays paused until the person resumes it. Obligation work toward a
 * case the company already started: it runs whatever the start gates say.
 * Answers the refreshed case.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.collection.possible_payment',
  async (request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, PossiblePaymentBodySchema, { log: ctx.log, operation: 'invoice.collection.possible_payment' })
    if (!body.success) return body.response

    const db = createServiceClient()
    const outcome = await dismissPossiblePayment(db, {
      companyId: ctx.companyId,
      invoiceId: parsed.data.id,
      hitId: body.data.hit_id,
      userId: ctx.user.id,
    })
    if (!outcome.ok) return errorResponseFromCode(outcome.code, ctx.log, { requestId: ctx.requestId })

    const view = await loadInvoiceCase({ db, log: ctx.log }, ctx.companyId, parsed.data.id, { refresh: false })
    return NextResponse.json({ data: { case: view } })
  },
  { requireWrite: true },
)
