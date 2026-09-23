import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { loadConnectedAiClients } from '@/lib/onboarding/ai-clients.server'
import { countVerifikatMissingDocument } from '@/lib/worklist/categories'

ensureInitialized()

/**
 * GET /api/receipt-hunt/agent-handoff: what the Kvittojakten button needs to
 * decide whether to show itself outside Hem (the invoice inbox header).
 *
 * `clients` is which of Claude / ChatGPT / Grok this user has connected over
 * MCP; `count` is the Att göra row's own number (posted verifikat without
 * underlag), so the button and the row can never disagree. Read-only.
 *
 * Response: { data: { clients: AiClient[], count: number } }
 */
export const GET = withRouteContext('receipt_hunt.agent_handoff', async (_request, ctx) => {
  const { supabase, companyId, user } = ctx
  // api_keys follow the person, not the company, and are read with the
  // service client on Hem for the same reason: see loadConnectedAiClients.
  const serviceClient = await createServiceClient()
  const [clients, count] = await Promise.all([
    loadConnectedAiClients(serviceClient, user.id),
    countVerifikatMissingDocument(supabase, companyId),
  ])
  return NextResponse.json({ data: { clients, count } })
})
