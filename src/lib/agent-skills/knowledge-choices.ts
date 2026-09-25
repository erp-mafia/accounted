import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENTS, OWN_AGENT_KNOWLEDGE } from './agents'
import { isAgentId } from './agent-bundle'
import { toSummary } from './atoms'
import { loadCompanySkillRows, ownSkill } from './company-skills'

export interface KnowledgeOption {
  id: string
  tier: 'horizontal' | 'vertical' | 'modifier' | 'community'
  title: string
  summary: string
  version: number | null
  reviewed_at: string | null
}

/** Every pack a company can give an agent: live, exposed and top level (references travel with their pack). */
export async function loadKnowledgeOptions(supabase: SupabaseClient): Promise<KnowledgeOption[]> {
  const { data, error } = await supabase.from('agent_atom_registry')
    .select('id, tier, title, description, version, reviewed_at')
    .eq('is_active', true).eq('mcp_exposed', true).is('parent_atom_id', null)
    .order('tier').order('id')
  if (error) throw new Error(`Failed to load knowledge options: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; tier: KnowledgeOption['tier']; title: string | null; description: string; version: number | null; reviewed_at: string | null }>)
    .map((row) => ({ id: row.id, tier: row.tier, title: row.title ?? row.id, summary: toSummary(row.description, 160), version: row.version, reviewed_at: row.reviewed_at }))
}

/** The defaults an agent ships with; null when the agent does not exist for this company. */
export async function agentDefaults(supabase: SupabaseClient, companyId: string, agentId: string): Promise<readonly string[] | null> {
  if (isAgentId(agentId)) return AGENTS[agentId].knowledge
  if (!agentId.startsWith('own/')) return null
  const row = (await loadCompanySkillRows(supabase, companyId)).find((r) => `own/${r.id}` === agentId)
  return row && ownSkill(row) ? OWN_AGENT_KNOWLEDGE : null
}

export type KnowledgeAction = 'add' | 'remove' | 'reset'

/**
 * One change to what an agent knows. Adding a default back or removing an
 * added pack deletes the row, so the table only holds real differences from
 * the agent's defaults.
 */
export async function applyKnowledgeChoice(
  supabase: SupabaseClient,
  companyId: string,
  agentId: string,
  defaults: readonly string[],
  action: KnowledgeAction,
  atomId?: string,
): Promise<void> {
  const rows = supabase.from('company_agent_knowledge')
  if (action === 'reset') {
    const { error } = await rows.delete().eq('company_id', companyId).eq('agent_id', agentId)
    if (error) throw error
    return
  }
  const isDefault = defaults.includes(atomId!)
  const wantsRow = (action === 'add' && !isDefault) || (action === 'remove' && isDefault)
  if (!wantsRow) {
    const { error } = await rows.delete().eq('company_id', companyId).eq('agent_id', agentId).eq('atom_id', atomId!)
    if (error) throw error
    return
  }
  const { error } = await rows.upsert(
    { company_id: companyId, agent_id: agentId, atom_id: atomId!, included: action === 'add' },
    { onConflict: 'company_id,agent_id,atom_id' },
  )
  if (error) throw error
}
