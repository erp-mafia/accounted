import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { readAiConnection } from '@/lib/onboarding/ai-clients.server'

/**
 * GET /api/onboarding/ai-status
 *
 * Whether this user has an agent connected over MCP OAuth, and which of the
 * three named clients it is: the one question
 * the books act's Done step polls while a sign-in is under way in another
 * tab. One api_keys read and nothing from the ledger; the full Genomlysning
 * stays on /api/onboarding/findings. The session client is deliberate: the
 * api_keys_select policy (user_id = auth.uid()) scopes the read to the
 * caller in the database as well. A failed read is a 500, never an empty
 * list, so the poller keeps the last known state. Read-only.
 *
 * Response: { data: { connected: AiClient[], agentConnected: boolean } }.
 * `connected` is the verified clients; `agentConnected` is true for any live
 * OAuth MCP key, also one that names no client (see AiConnection).
 */
export const GET = withRouteContext('onboarding-ai-status.get', async (_request, { supabase, user }) => {
  const connection = await readAiConnection(supabase, user.id)
  return NextResponse.json({ data: { connected: connection.clients, agentConnected: connection.connected } })
})
