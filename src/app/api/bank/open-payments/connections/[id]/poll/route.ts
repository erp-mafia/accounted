import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { pollBankFeedConsent } from '@/lib/bank-feed/service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'

/** The body is optional: the typed personnummer may come along, so the bank sees the PSU on the poll too. */
const PollSchema = z.object({
  personal_number: z.string().max(20).nullish(),
  /** Nordea Corporate Netbank: the signer's own logon id, when they use it. Sent with a Nordea signing only, never stored. */
  psu_authoriser_id: z.string().max(100).nullish(),
})

async function readOptionalBody(request: Request): Promise<z.infer<typeof PollSchema>> {
  const text = await request.text().catch(() => '')
  if (!text.trim()) return {}
  try {
    const parsed = PollSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/**
 * POST /api/bank/open-payments/connections/:id/poll: where the BankID stands.
 * The row carries the consent, the authorisation and the method; the body
 * may repeat the typed personnummer (never stored) so the bank sees the PSU
 * on the poll as on the start. While pending it answers fresh QR data (the
 * animated QR changes every second); once the bank reports the consent
 * valid, the accounts it reaches are read and the connection awaits account
 * selection.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bank_feed.poll',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const body = await readOptionalBody(request)
    const outcome = await pollBankFeedConsent(
      { supabase, companyId, userId: user.id, log },
      { connectionId: id, signer: signerFromRequest(request, body.personal_number, body.psu_authoriser_id) },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
