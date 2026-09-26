import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityType } from '@/types'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { AGENTS, OWN_AGENT_KNOWLEDGE } from './agents'
import { isAgentId } from './agent-bundle'
import { toSummary } from './atoms'
import { loadCompanySkillRows, ownSkill } from './company-skills'

export interface KnowledgeOption {
  /** A registry pack's id, or `own/<company_skills.id>` for the company's own knowledge. */
  id: string
  tier: 'horizontal' | 'vertical' | 'modifier' | 'community' | 'own'
  title: string
  summary: string
  version: number | null
  reviewed_at: string | null
}

/**
 * Company-form packs whose law is about one legal form (docs/LEGAL-FORMS.md:
 * an array of form codes only when the law is about that form). Fåmansbolag
 * (3:12, lön eller utdelning) and holding structures are aktiebolag law, so an
 * enskild firma is never offered them: given to a flow, they would feed its AI
 * the wrong rules. Every pack not listed fits every company.
 */
export const PACK_LEGAL_FORMS: Readonly<Record<string, readonly EntityType[]>> = {
  'modifier/holding-ab': ['aktiebolag'],
  'modifier/single-shareholder-ab-fmb': ['aktiebolag'],
}

/** Whether a pack applies to a company of this legal form. */
export function packFitsForm(atomId: string, entityType: EntityType): boolean {
  const forms = PACK_LEGAL_FORMS[atomId]
  return !forms || forms.includes(entityType)
}

/**
 * Every pack a company can give an agent: live, exposed, top level
 * (references travel with their pack) and written for its legal form, then
 * the company's own knowledge items (added by a person, not withdrawn) as
 * `own/<id>`. Adding a pack checks against this list, so a pack for another
 * legal form cannot be added either.
 */
export async function loadKnowledgeOptions(supabase: SupabaseClient, companyId: string): Promise<KnowledgeOption[]> {
  const [entityType, { data, error }, rows] = await Promise.all([
    resolveCompanyEntityType(supabase, companyId),
    supabase.from('agent_atom_registry')
      .select('id, tier, title, description, version, reviewed_at')
      .eq('is_active', true).eq('mcp_exposed', true).is('parent_atom_id', null)
      .order('tier').order('id'),
    loadCompanySkillRows(supabase, companyId),
  ])
  if (error) throw new Error(`Failed to load knowledge options: ${error.message}`)
  const packs = ((data ?? []) as Array<{ id: string; tier: KnowledgeOption['tier']; title: string | null; description: string; version: number | null; reviewed_at: string | null }>)
    .filter((row) => packFitsForm(row.id, entityType))
    .map((row) => ({ id: row.id, tier: row.tier, title: row.title ?? row.id, summary: toSummary(row.description, 160), version: row.version, reviewed_at: row.reviewed_at }))
  const own = rows.flatMap((row): KnowledgeOption[] => {
    const skill = ownSkill(row)
    return skill && skill.itemKind === 'rules'
      ? [{ id: skill.slug, tier: 'own', title: skill.name, summary: toSummary(skill.summary, 160), version: null, reviewed_at: null }]
      : []
  })
  return [...packs, ...own]
}

/** `own/<uuid>` is the company's own knowledge item; anything else is a registry pack. */
export function ownKnowledgeId(id: string): string | null {
  return /^own\/[0-9a-f-]{36}$/.test(id) ? id.slice(4) : null
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
  // Own knowledge is never a default: adding writes a row, taking it away deletes it.
  const ownId = ownKnowledgeId(atomId!)
  if (ownId) {
    const { error } = action === 'add'
      ? await rows.upsert({ company_id: companyId, agent_id: agentId, own_skill_id: ownId, included: true }, { onConflict: 'company_id,agent_id,own_skill_id' })
      : await rows.delete().eq('company_id', companyId).eq('agent_id', agentId).eq('own_skill_id', ownId)
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
