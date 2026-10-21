import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { activateSending, deactivateSending } from '@/lib/digital-mailboxes/connect'
import { summariseConnection } from '@/lib/digital-mailboxes/connections'
import { isDigitalMailboxProvider } from '@/lib/digital-mailboxes/types'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ provider: string }> }

/**
 * POST /api/digital-mailboxes/{kivra|billo}/send: register the company as
 * a sender at the provider, so its invoices and payslips can be sent to
 * recipients' mailboxes. Idempotent. Admin only: the provider bills per
 * item sent.
 */
export const POST = withRouteContext<Params>(
  'digital_mailboxes.send.activate',
  async (_request, { companyId, user, log, requestId }, { params }) => {
    const { provider } = await params
    if (!isDigitalMailboxProvider(provider)) return errorResponseFromCode('DIGITAL_MAILBOX_UNKNOWN_PROVIDER', log, { requestId })
    const outcome = await activateSending(createServiceClient(), { companyId, userId: user.id, provider, log })
    if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId, reason: outcome.reason })
    return privateNoStore(NextResponse.json({ data: { connection: summariseConnection(outcome.data) } }))
  },
  { requireAdmin: true },
)

/** DELETE /api/digital-mailboxes/{kivra|billo}/send: stop sending through the provider from Accounted. */
export const DELETE = withRouteContext<Params>(
  'digital_mailboxes.send.deactivate',
  async (_request, { companyId, log, requestId }, { params }) => {
    const { provider } = await params
    if (!isDigitalMailboxProvider(provider)) return errorResponseFromCode('DIGITAL_MAILBOX_UNKNOWN_PROVIDER', log, { requestId })
    const connection = await deactivateSending(createServiceClient(), { companyId, provider })
    return privateNoStore(NextResponse.json({ data: { connection: connection ? summariseConnection(connection) : null } }))
  },
  { requireAdmin: true },
)
