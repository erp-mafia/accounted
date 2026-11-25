import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { kivraCompanyMailboxForCompany, type CompanyMailboxMatch } from '@/lib/digital-mailboxes/company-mailbox'
import { listConnections, summariseConnection, type ConnectionSummary } from '@/lib/digital-mailboxes/connections'
import { digitalMailboxAvailability, type DigitalMailboxAvailability } from '@/lib/digital-mailboxes/providers'
import { DIGITAL_MAILBOX_PROVIDERS, type DigitalMailboxProviderId } from '@/lib/digital-mailboxes/types'

interface ProviderAnswer {
  available: DigitalMailboxAvailability
  connection: ConnectionSummary | null
  company_mailbox?: CompanyMailboxMatch
}

/**
 * GET /api/digital-mailboxes: what Kivra and Billo can do for the active
 * company (receive, send: the deployment's credentials and the company's
 * place in the rollout) and its connection to each. Never the provider's
 * keys or the company's ids at the provider. With `?company_mailbox=1`, and
 * while Kivra is not connected for receiving, Kivra's answer also carries
 * `company_mailbox` (has, none or unknown): whether the company already has a
 * company mailbox there. That is one call to the provider, so only the list
 * of mailboxes asks for it; the callers that only need the connections do not.
 */
export const GET = withRouteContext('digital_mailboxes.list', async (request, { supabase, companyId }) => {
  const availability = digitalMailboxAvailability(companyId)
  const rows = await listConnections(supabase, companyId)
  const providers = Object.fromEntries(
    DIGITAL_MAILBOX_PROVIDERS.map((id) => {
      const row = rows.find((r) => r.provider === id)
      return [id, { available: availability[id], connection: row ? summariseConnection(row) : null }]
    }),
  ) as Record<DigitalMailboxProviderId, ProviderAnswer>
  if (new URL(request.url).searchParams.get('company_mailbox') === '1') {
    const companyMailbox = await kivraCompanyMailboxForCompany(supabase, companyId, providers.kivra.connection)
    if (companyMailbox) providers.kivra.company_mailbox = companyMailbox
  }
  return privateNoStore(NextResponse.json({ data: { providers } }))
})
