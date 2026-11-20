import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getCompanyPaymentVerification, startCompanyPaymentVerification } from '@/lib/payments/orders/availability'

/**
 * GET /api/payments/verification: has the payment provider verified the
 * company (know your customer), and where the verification stands (state).
 * `?refresh=1` asks the provider even when the stored answer is fresh: the
 * dialog's poll while a form is open.
 */
export const GET = withRouteContext('payments.verification_status', async (request, { supabase, companyId, user, log, requestId }) => {
  const refresh = new URL(request.url).searchParams.get('refresh') === '1'
  const outcome = await getCompanyPaymentVerification({ supabase, companyId, userId: user.id, log }, { refresh })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})

const StartBody = z.object({
  /** The link goes to a firmatecknare (mailed or copied for them), not to the person at the screen. */
  handoff: z.boolean().optional(),
})

/** The body is optional: an empty POST starts a form for the person at the screen. */
async function readStartBody(request: Request): Promise<z.infer<typeof StartBody> | null> {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    const parsed = StartBody.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * POST /api/payments/verification: a link to the provider's verification form
 * for the company (valid 24 h). Body `{ handoff: true }` when the link is for
 * a firmatecknare: the state then reads awaiting_signatory.
 */
export const POST = withRouteContext(
  'payments.verification_start',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const body = await readStartBody(request)
    if (!body) return NextResponse.json({ error: 'Invalid JSON in request body', type: 'validation_error' }, { status: 400 })
    const outcome = await startCompanyPaymentVerification({ supabase, companyId, userId: user.id, log }, { handoff: body.handoff === true })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
