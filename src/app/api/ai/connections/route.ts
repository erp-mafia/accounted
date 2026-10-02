import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadAiConnection } from '@/lib/onboarding/ai-clients.server'

/**
 * GET /api/ai/connections
 *
 * `data` is the verified clients (Claude, ChatGPT, Grok) work can be handed
 * to. `agentConnected` answers "is an agent connected": any live OAuth MCP
 * key for this user, whatever its client, so a key that names no client
 * (older than the client column, or Cursor, a localhost bridge) reads as
 * connected with an empty `data` (see AiConnection).
 */
export const GET = withRouteContext('ai.connections.list', async (_request, { supabase, user }) => {
  const connection = await loadAiConnection(supabase, user.id)
  return NextResponse.json(
    { data: connection.clients, agentConnected: connection.connected },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
})
