import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { requestMoreBankPayments } from '@/lib/payments/allowance'
import { createServiceClient } from '@/lib/supabase/server'

const RequestSchema = z.object({
  /** Payments a month the company needs. */
  monthly_payments_wanted: z.number().int().min(1).max(10000),
  message: z.string().max(2000).nullish(),
})

/**
 * POST /api/payments/allowance-requests: Begär fler betalningar. Stores the
 * request and mails support with the company, the requester, this month's
 * usage and what is asked for; a founder raises the cap by hand
 * (company_bank_payment_allowances). 201 with the request id; 409
 * BANK_PAYMENTS_ALLOWANCE_REQUEST_OPEN while an unanswered request from the
 * company is younger than a day.
 */
export const POST = withRouteContext(
  'payments.allowance_request',
  async (request, { companyId, user, log, requestId }) => {
    const validation = await validateBody(request, RequestSchema)
    if (!validation.success) return validation.response
    const message = validation.data.message?.trim() || null
    // The table has no browser-session write: the request is the server's to store.
    const outcome = await requestMoreBankPayments(
      createServiceClient(),
      { companyId, userId: user.id, email: user.email ?? null, log },
      { monthlyPaymentsWanted: validation.data.monthly_payments_wanted, message },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
