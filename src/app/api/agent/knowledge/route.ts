import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getCompanyDisplayName } from '@/lib/company/context'
import { buildLedgerContext } from '@/lib/agent-context/ledger-context'
import { buildDeepEntities } from '@/lib/agent-context/ledger-deep'
import { buildAgentCompetence } from '@/lib/agent-context/agent-competence'

// GET /api/agent/knowledge
//
// Read-only transparency surface for "Vad din agent vet": the exact ledger
// context the AI agent reads before booking, plus the deep entity-resolved
// profile and the agent's competence. Powers the Kunskap tab in the assistant
// settings hub (client-fetched so it renders identically in the full-page
// settings rail and the routed settings modal, which both mount the same
// propless content component). Derived per request from live bookings; never
// cached, so a fixed profile can't go stale.
export const GET = withRouteContext('agent.knowledge.get', async (_request, ctx) => {
  const { supabase, companyId } = ctx

  const [context, deep, competence, companyName] = await Promise.all([
    buildLedgerContext(supabase, companyId),
    buildDeepEntities(supabase, companyId),
    buildAgentCompetence(supabase, companyId),
    getCompanyDisplayName(supabase, companyId),
  ])

  return NextResponse.json({
    data: { context, deep, competence, companyName: companyName ?? '' },
  })
})
