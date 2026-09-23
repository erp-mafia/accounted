import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { readConnectedAiClients } from '@/lib/onboarding/ai-clients.server'

/**
 * GET /api/onboarding/ai-status
 *
 * Which AI clients this user has connected over MCP OAuth: the one question
 * the books act's Done step polls while a sign-in is under way in another
 * tab. One api_keys read and nothing from the ledger; the full Genomlysning
 * stays on /api/onboarding/findings. The session client is deliberate: the
 * api_keys_select policy (user_id = auth.uid()) scopes the read to the
 * caller in the database as well. A failed read is a 500, never an empty
 * list, so the poller keeps the last known state. Read-only.
 *
 * Response: { data: { connected: AiClient[] } }
 */
export const GET = withRouteContext('onboarding-ai-status.get', async (_request, { supabase, user }) => {
  const connected = await readConnectedAiClients(supabase, user.id)
  return NextResponse.json({ data: { connected } })
})
