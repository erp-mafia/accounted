import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { agentDefaults, applyKnowledgeChoice, loadKnowledgeOptions } from '@/lib/agent-skills/knowledge-choices'

const failure = (status: number, code: string, message: string, message_en: string) => NextResponse.json({ error: { code, message, message_en } }, { status })

/** The packs a company can give its agents, and its own knowledge. */
export const GET = withRouteContext('agents.knowledge.list', async (_request, { supabase, companyId }) => {
  const options = await loadKnowledgeOptions(supabase, companyId)
  return NextResponse.json({ data: options }, { headers: { 'Cache-Control': 'private, no-store' } })
})

const ChoiceSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['add', 'remove']), agent_id: z.string().regex(/^(own\/[0-9a-f-]{36}|[a-z0-9][a-z0-9-]{0,63})$/), atom_id: z.string().min(1).max(250) }).strict(),
  z.object({ action: z.literal('reset'), agent_id: z.string().regex(/^(own\/[0-9a-f-]{36}|[a-z0-9][a-z0-9-]{0,63})$/) }).strict(),
])

/** Add a pack to an agent, take one away, or reset the agent to its defaults. */
export const PATCH = withRouteContext('agents.knowledge.update', async (request, { supabase, companyId }) => {
  const validation = await validateBody(request, ChoiceSchema)
  if (!validation.success) return validation.response
  const input = validation.data
  const defaults = await agentDefaults(supabase, companyId, input.agent_id)
  if (!defaults) return failure(404, 'NOT_FOUND', 'Agenten hittades inte.', 'Agent not found.')
  if (input.action === 'add') {
    const options = await loadKnowledgeOptions(supabase, companyId)
    if (!options.some((o) => o.id === input.atom_id)) return failure(404, 'NOT_FOUND', 'Kunskapen finns inte eller är inte tillgänglig.', 'Knowledge not found or unavailable.')
  }
  await applyKnowledgeChoice(supabase, companyId, input.agent_id, defaults, input.action, input.action === 'reset' ? undefined : input.atom_id)
  return NextResponse.json({ data: { agent_id: input.agent_id } })
}, { requireWrite: true })
