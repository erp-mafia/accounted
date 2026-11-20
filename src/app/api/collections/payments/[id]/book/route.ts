import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { bookCollectedPayment } from '@/lib/collections/collected-payments'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

const ParamsSchema = z.object({ id: z.uuid() })

const REFUSALS = {
  not_found: 'COLLECTED_PAYMENT_NOT_FOUND',
  ignored: 'COLLECTED_PAYMENT_IGNORED',
  busy: 'COLLECTED_PAYMENT_BUSY',
} as const

/**
 * POST /api/collections/payments/[id]/book: book a payment the debtor made
 * to the collections provider as a payment of the invoice, against the
 * clearing account, on the day the debtor paid. A payment the books refuse
 * (locked period, invoice already paid) answers 200 with outcome
 * needs_review and the reason. An obligation path: served whatever the
 * start gates say.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'collections.payments.book',
  async (_request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const result = await bookCollectedPayment({ db: createServiceClient(), companyId: ctx.companyId, log: ctx.log }, parsed.data.id, {
      userId: ctx.user.id,
    })
    if (!result.ok && result.outcome !== 'needs_review') {
      return errorResponseFromCode(REFUSALS[result.outcome], ctx.log, { requestId: ctx.requestId })
    }
    return NextResponse.json({
      data: result.ok
        ? {
            outcome: 'booked',
            journal_entry_id: result.journalEntryId,
            invoice_payment_id: result.invoicePaymentId,
            write_off_id: result.writeOffId,
            already_booked: result.alreadyBooked,
          }
        : { outcome: 'needs_review', reason: result.reason },
    })
  },
  { requireWrite: true },
)
