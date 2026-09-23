import type { SupabaseClient } from '@supabase/supabase-js'
import type { Skill } from './types'
import { workflowSkills as coreWorkflowSkills } from '@/lib/agent-skills/workflows'
import { kvittojaktenSkills } from '@/lib/agent-skills/workflows/kvittojakten'
import { loadAtomsAsSkills, loadReferenceById } from './atoms'
import { resolveOwnSkill } from '@/lib/agent-skills/company-skills'
import { loadSkillCatalog } from '@/lib/agent-skills/catalog'

/** Static workflow skills the server ships with. Tier: 'workflow'. */
export const workflowSkills: Skill[] = [...coreWorkflowSkills, ...kvittojaktenSkills]

/**
 * Resolve a skill by slug. Checks the static workflow array first (synchronous,
 * always available), then falls back to the registry-backed atom set
 * (asynchronous, supabase-bound).
 */
export async function findSkill(slug: string, supabase?: SupabaseClient, companyId?: string | null): Promise<Skill | null> {
  if (slug.startsWith('own/')) return supabase && companyId ? resolveOwnSkill(supabase, companyId, slug) : null
  const wf = workflowSkills.find((s) => s.slug === slug)
  if (wf) return wf
  if (!supabase) return null
  const atoms = await loadAtomsAsSkills(supabase)
  const atom = atoms.find((s) => s.slug === slug)
  if (atom) return atom
  // Reference children (e.g. "horizontal/swedish-vat/vat-compliance-reference")
  // are excluded from the listed atom set above, so resolve them directly. This
  // is what makes a SKILL.md footer's gnubok_load_skill(<reference id>) work.
  return loadReferenceById(supabase, slug)
}

/** Workflow skills + registry-loaded atoms in one list. */
export async function loadAllSkills(supabase: SupabaseClient, companyId?: string | null, includeAll = false): Promise<Skill[]> {
  if (companyId) return (await loadSkillCatalog(supabase, companyId)).filter((skill) => skill.shareStatus !== 'withdrawn' && (includeAll || skill.active || skill.tier === 'community'))
  const atoms = await loadAtomsAsSkills(supabase)
  return [...workflowSkills, ...atoms]
}

export type { Skill, SkillTier } from './types'
export { SKILL_MIME_TYPE, SKILL_URI_PREFIX, skillUri, skillSlugFromUri } from './types'
export { loadAtomsAsSkills, toSummary, __resetAtomCache } from './atoms'
