import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadConnectedAiClients } from '@/lib/onboarding/ai-clients.server'

export const GET = withRouteContext('ai.connections.list', async (_request, { supabase, user }) => {
  const clients = await loadConnectedAiClients(supabase, user.id)
  return NextResponse.json({ data: clients }, { headers: { 'Cache-Control': 'private, no-store' } })
})
