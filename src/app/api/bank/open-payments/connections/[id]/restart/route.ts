import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { restartBankFeedConsent } from '@/lib/bank-feed/service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'

/** The body is optional: the row carries the method; a typed personnummer may come along. */
const RestartSchema = z.object({
  method: z.enum(['same_device', 'qr']).nullish(),
  personal_number: z.string().max(20).nullish(),
})

async function readOptionalBody(request: Request): Promise<z.infer<typeof RestartSchema>> {
  const text = await request.text().catch(() => '')
  if (!text.trim()) return {}
  try {
    const parsed = RestartSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/**
 * POST /api/bank/open-payments/connections/:id/restart: a new BankID
 * authorisation for the pending consent (a new consent when the bank says
 * the first is over). Same answer shape as creating the connection.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bank_feed.restart',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const body = await readOptionalBody(request)
    const outcome = await restartBankFeedConsent(
      { supabase, companyId, userId: user.id, log },
      { connectionId: id, method: body.method ?? null, signer: signerFromRequest(request, body.personal_number) },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
