import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { createServiceClient } from '@/lib/supabase/server'
import { isPricedKind, USAGE_GATED_KINDS, USAGE_KINDS } from '@/lib/usage/kinds'
import { requestMoreUsage } from '@/lib/usage/requests'

const RequestSchema = z.object({
  kind: z.enum(USAGE_KINDS),
  message: z.string().max(2000).nullish(),
})

/**
 * POST /api/billing/usage/requests { kind, message? }: Begär fler. Stores the
 * request and mails support with the company, the requester and the month's
 * usage; a founder opens the charge for the company by hand
 * (lib/usage/consent.ts). 201 with the request id; 409 USAGE_REQUEST_OPEN
 * while an unanswered request for the kind is younger than a day. A kind with
 * no price to open answers 400. Bank payments ask through
 * POST /api/payments/allowance-requests instead.
 */
export const POST = withRouteContext(
  'billing.usage.request',
  async (request, { companyId, user, log, requestId }) => {
    const validation = await validateBody(request, RequestSchema, { log, operation: 'billing.usage.request' })
    if (!validation.success) return validation.response
    const { kind } = validation.data
    if (kind === 'bank_payment' || !USAGE_GATED_KINDS.has(kind) || !isPricedKind(kind)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { field: 'kind', reason: 'not_requestable' } })
    }
    const message = validation.data.message?.trim() || null
    // The table has no browser-session write: the request is the server's to store.
    const outcome = await requestMoreUsage(createServiceClient(), { companyId, userId: user.id, email: user.email ?? null, log }, { kind, message })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
