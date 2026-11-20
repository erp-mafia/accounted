import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { rebookCollectedPayment } from '@/lib/collections/rebook'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

const ParamsSchema = z.object({ id: z.uuid() })

const REFUSALS = {
  not_found: 'COLLECTED_PAYMENT_NOT_FOUND',
  not_booked: 'COLLECTED_PAYMENT_NOT_BOOKED',
  settled: 'COLLECTED_PAYMENT_SETTLED',
  busy: 'COLLECTED_PAYMENT_BUSY',
  voucher_not_posted: 'COLLECTED_PAYMENT_VOUCHER_NOT_POSTED',
} as const

/**
 * POST /api/collections/payments/[id]/rebook ("Bokför om"): storno the
 * voucher of a booked payment the collections provider collected and book
 * it again, in one service call (lib/collections/rebook.ts). The generic
 * storno of such a voucher is refused; this is the sanctioned path. A
 * storno the books refuse (a locked period) changes nothing and answers
 * with the bookkeeping error; a new booking the books refuse answers 200
 * with outcome needs_review. An obligation path: served whatever the start
 * gates say.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'collections.payments.rebook',
  async (_request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const result = await rebookCollectedPayment({ db: createServiceClient(), companyId: ctx.companyId, log: ctx.log }, parsed.data.id, {
      userId: ctx.user.id,
    })
    if (!result.ok) return errorResponseFromCode(REFUSALS[result.outcome], ctx.log, { requestId: ctx.requestId })
    const booking = result.booking
    return NextResponse.json({
      data: {
        reversed_entry_id: result.reversedEntryId,
        storno_entry_id: result.stornoEntryId,
        ...(booking.ok
          ? { outcome: 'booked', journal_entry_id: booking.journalEntryId, invoice_payment_id: booking.invoicePaymentId, write_off_id: booking.writeOffId }
          : booking.outcome === 'needs_review'
            ? { outcome: 'needs_review', reason: booking.reason }
            : { outcome: booking.outcome }),
      },
    })
  },
  { requireWrite: true },
)
