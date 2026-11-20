import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { loadAgentsOverview } from '@/lib/agent-skills/agent-bundle'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'

const QuerySchema = z.object({
  client: z.enum(AI_CLIENTS.map((c) => c.id) as [AiClient, ...AiClient[]]).optional(),
}).strict()

/** The Agenter page: every agent's knowledge, the company's own atoms and connection states. */
export const GET = withRouteContext('agents.list', async (request, { supabase, companyId }) => {
  const query = validateQuery(request, QuerySchema)
  if (!query.success) return query.response
  const overview = await loadAgentsOverview(supabase, companyId, query.data.client)
  return NextResponse.json({ data: overview }, { headers: { 'Cache-Control': 'private, no-store' } })
})
