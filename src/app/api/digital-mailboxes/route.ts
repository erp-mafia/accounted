import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listConnections, summariseConnection } from '@/lib/digital-mailboxes/connections'
import { digitalMailboxAvailability } from '@/lib/digital-mailboxes/providers'
import { DIGITAL_MAILBOX_PROVIDERS } from '@/lib/digital-mailboxes/types'

/**
 * GET /api/digital-mailboxes: what Kivra and Billo can do in this deployment
 * (receive, send) and the active company's connection to each. Never the
 * provider's keys or the company's ids at the provider.
 */
export const GET = withRouteContext('digital_mailboxes.list', async (_request, { supabase, companyId }) => {
  const availability = digitalMailboxAvailability()
  const rows = await listConnections(supabase, companyId)
  const providers = Object.fromEntries(
    DIGITAL_MAILBOX_PROVIDERS.map((id) => {
      const row = rows.find((r) => r.provider === id)
      return [id, { available: availability[id], connection: row ? summariseConnection(row) : null }]
    }),
  )
  return privateNoStore(NextResponse.json({ data: { providers } }))
})
