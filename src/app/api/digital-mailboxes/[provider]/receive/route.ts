import { NextResponse } from 'next/server'
import { z } from 'zod'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { connectBilloReceive, connectKivraReceive, disconnectReceive } from '@/lib/digital-mailboxes/connect'
import { summariseConnection } from '@/lib/digital-mailboxes/connections'
import { phoneToE164 } from '@/lib/digital-mailboxes/identifiers'
import { isDigitalMailboxProvider } from '@/lib/digital-mailboxes/types'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

export const maxDuration = 60

type Params = { params: Promise<{ provider: string }> }

/** Billo needs a reachable representative; the personnummer comes from the admin's BankID login, never from the body. */
const BilloConnectBody = z.object({
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(6).max(32),
})

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * POST /api/digital-mailboxes/{kivra|billo}/receive: start reading the
 * company's mailbox into the Inkorg (lib/digital-mailboxes/connect.ts).
 *   - kivra: no body. Answers the connection and, until Kivra confirms the
 *     activation, the onboarding_url where the admin activates Accounted.
 *   - billo: { email, phone } of the representative. Creates the company's
 *     Billo business mailbox with the admin (BankID-verified) as its
 *     representative and starts reading it.
 * Admin only: it connects an outside service to the company's mail.
 */
export const POST = withRouteContext<Params>(
  'digital_mailboxes.receive.connect',
  async (request, { companyId, user, log, requestId }, { params }) => {
    const { provider } = await params
    if (!isDigitalMailboxProvider(provider)) return errorResponseFromCode('DIGITAL_MAILBOX_UNKNOWN_PROVIDER', log, { requestId })
    const service = createServiceClient()

    if (provider === 'kivra') {
      const outcome = await connectKivraReceive(service, { companyId, userId: user.id, log })
      if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId, reason: outcome.reason })
      return privateNoStore(
        NextResponse.json({
          data: { connection: summariseConnection(outcome.data.connection), onboarding_url: outcome.data.onboardingUrl },
        }),
      )
    }

    const raw = await readJson(request)
    const body = BilloConnectBody.safeParse(raw)
    const phone = body.success ? phoneToE164(body.data.phone) : null
    if (!body.success || !phone) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { fields: body.success ? ['phone'] : body.error.issues.map((i) => i.path.join('.')) },
      })
    }
    const outcome = await connectBilloReceive(service, {
      companyId,
      userId: user.id,
      representative: { email: body.data.email, phone },
      log,
    })
    if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId, reason: outcome.reason })
    return privateNoStore(NextResponse.json({ data: { connection: summariseConnection(outcome.data), onboarding_url: null } }))
  },
  { requireAdmin: true },
)

/**
 * DELETE /api/digital-mailboxes/{kivra|billo}/receive: stop reading the
 * mailbox. Billo's enrolment is ended at Billo; a Kivra company switches
 * Accounted off in Kivra itself. What was already filed stays (BFL 7 kap).
 */
export const DELETE = withRouteContext<Params>(
  'digital_mailboxes.receive.disconnect',
  async (_request, { companyId, log, requestId }, { params }) => {
    const { provider } = await params
    if (!isDigitalMailboxProvider(provider)) return errorResponseFromCode('DIGITAL_MAILBOX_UNKNOWN_PROVIDER', log, { requestId })
    try {
      const connection = await disconnectReceive(createServiceClient(), { companyId, provider, log })
      return privateNoStore(NextResponse.json({ data: { connection: connection ? summariseConnection(connection) : null } }))
    } catch (err) {
      // The provider's text stays in the log; the person reads the code's sentence.
      log.warn('digital mailbox provider call failed', { provider, reason: err instanceof Error ? err.message : String(err) })
      return errorResponseFromCode('DIGITAL_MAILBOX_PROVIDER_FAILED', log, { requestId })
    }
  },
  { requireAdmin: true },
)
