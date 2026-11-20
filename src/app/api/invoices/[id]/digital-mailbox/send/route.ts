import { NextResponse } from 'next/server'
import { z } from 'zod'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sendInvoiceToDigitalMailbox } from '@/lib/invoices/digital-mailbox-send'
import { createServiceClient } from '@/lib/supabase/server'

export const maxDuration = 60

const Body = z.object({ provider: z.enum(['kivra', 'billo']) })

/**
 * POST /api/invoices/{id}/digital-mailbox/send { provider }: send the
 * invoice to the customer's Kivra or Billo mailbox
 * (lib/invoices/digital-mailbox-send.ts). A draft is issued on the way, fail
 * closed, after every refusing check; a delivery that fails after the issue
 * answers DIGITAL_MAILBOX_SEND_FAILED with details.issued, and sending again
 * resends the issued invoice.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.digital_mailbox.send',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      raw = undefined
    }
    const body = Body.safeParse(raw)
    if (!body.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { field: 'provider' } })
    }

    const outcome = await sendInvoiceToDigitalMailbox(
      { supabase, service: createServiceClient(), companyId, userId: user.id, log },
      id,
      body.data.provider,
    )
    if (!outcome.ok) {
      // The engine's own refusal (a locked period, an account outside the
      // chart) says what to fix, as on the send and mark-sent routes.
      if (isBookkeepingError(outcome.bookingError)) return errorResponse(outcome.bookingError, log, { requestId })
      return errorResponseFromCode(outcome.code, log, {
        requestId,
        ...(outcome.details ? { details: outcome.details } : {}),
        ...(outcome.messageSv ? { messageSv: outcome.messageSv, messageEn: outcome.messageEn } : {}),
      })
    }
    return privateNoStore(NextResponse.json({ data: outcome.data }))
  },
  { requireWrite: true },
)
