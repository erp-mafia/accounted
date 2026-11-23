import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { activatePendingKivra, loadCompanyIdentity } from '@/lib/digital-mailboxes/connect'
import { getConnection } from '@/lib/digital-mailboxes/connections'
import { getDigitalMailboxProviders } from '@/lib/digital-mailboxes/providers'
import { InboxUnavailableError, syncConnection } from '@/lib/digital-mailboxes/receive'
import { isDigitalMailboxProvider } from '@/lib/digital-mailboxes/types'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

export const maxDuration = 120

/**
 * POST /api/digital-mailboxes/{kivra|billo}/sync: "Hämta nu". Reads the
 * company's mailbox at once instead of at the next cron run; a Kivra
 * connection still waiting for its activation is looked up first. Files at
 * most one run's worth (the rest follows with the cron).
 */
export const POST = withRouteContext<{ params: Promise<{ provider: string }> }>(
  'digital_mailboxes.sync',
  async (_request, { companyId, user, log, requestId }, { params }) => {
    const { provider } = await params
    if (!isDigitalMailboxProvider(provider)) return errorResponseFromCode('DIGITAL_MAILBOX_UNKNOWN_PROVIDER', log, { requestId })
    const providers = getDigitalMailboxProviders()
    const receiver = providers[provider]?.receiver
    if (!receiver) return errorResponseFromCode('DIGITAL_MAILBOX_NOT_CONFIGURED', log, { requestId })

    const service = createServiceClient()
    let connection = await getConnection(service, companyId, provider)
    if (connection?.receive_state === 'pending' && provider === 'kivra' && providers.kivra) {
      const identity = await loadCompanyIdentity(service, companyId)
      if (identity?.orgNumber) {
        const activation = await activatePendingKivra(service, providers.kivra, connection, identity.orgNumber, log)
        // Why the company may not read the inbox is the answer, not "not connected yet".
        if (!activation.ok) return errorResponseFromCode(activation.code, log, { requestId })
        connection = activation.data ?? connection
      }
    }
    if (connection?.receive_state !== 'active') {
      return errorResponseFromCode('DIGITAL_MAILBOX_NOT_CONNECTED', log, { requestId, details: { state: connection?.receive_state ?? 'off' } })
    }

    try {
      const result = await syncConnection(service, {
        connection,
        receiver,
        actor: { type: 'user', user_id: user.id, label: provider === 'kivra' ? 'Kivra' : 'Billo' },
        log,
      })
      return privateNoStore(NextResponse.json({ data: result }))
    } catch (err) {
      if (err instanceof InboxUnavailableError) return errorResponseFromCode('DIGITAL_MAILBOX_INBOX_UNAVAILABLE', log, { requestId })
      // The provider's text stays in the log; the person reads the code's sentence.
      log.warn('digital mailbox provider call failed', { provider, reason: err instanceof Error ? err.message : String(err) })
      return errorResponseFromCode('DIGITAL_MAILBOX_PROVIDER_FAILED', log, { requestId })
    }
  },
  { requireWrite: true },
)
