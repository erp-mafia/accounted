import type { SupabaseClient } from '@supabase/supabase-js'
import type { Skill } from '@/lib/agent-skills/types'
import { workflowSkills as coreWorkflowSkills } from '@/lib/agent-skills/workflows'
import { kvittojaktenSkills } from '@/lib/agent-skills/workflows/kvittojakten'
import { loadAtomsAsSkills, loadReferenceById } from '@/lib/agent-skills/atoms'
import { loadCompanySkillRows, resolveOwnSkill } from '@/lib/agent-skills/company-skills'
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
  if (companyId) return (await loadSkillCatalog(supabase, companyId)).filter((skill) => !skill.draft && (includeAll || skill.active || skill.tier === 'community'))
  const atoms = await loadAtomsAsSkills(supabase)
  return [...workflowSkills, ...atoms]
}

/**
 * own/<id> names a draft of this company: an AI saved it and no person has
 * added it yet, so it is listed but never loads. Every own/ slug that
 * gnubok_load_skill missed in 30 days named a row of the company: 3 drafts,
 * 3 added after the call.
 */
export async function isOwnSkillDraft(supabase: SupabaseClient, companyId: string, slug: string): Promise<boolean> {
  if (!slug.startsWith('own/')) return false
  const rows = await loadCompanySkillRows(supabase, companyId)
  return rows.some((row) => `own/${row.id}` === slug && row.draft === true)
}

/** Words of a guessed slug that say nothing about which skill: tier and path parts. */
const SLUG_NOISE = new Set(['horizontal', 'vertical', 'modifier', 'community', 'workflow', 'own', 'references', 'reference', 'md'])

function slugWords(slug: string): string[] {
  return slug.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !SLUG_NOISE.has(word))
}

/** The same word, or one a stem of the other: "close" and "closing", "invoice" and "invoicing". */
function sameWord(a: string, b: string): boolean {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n === a.length || n === b.length || n >= 4
}

/**
 * The slugs closest to one no skill has, best first: most words in common,
 * then fewest words besides. Agents guess a slug from a title ("payroll",
 * "month-close") or add or drop a tier prefix ("horizontal/bank-reconciliation",
 * "swedish-vat"); each lands on the skill it meant.
 */
export function closestSkillSlugs(wanted: string, slugs: readonly string[], max = 3): string[] {
  const asked = slugWords(wanted)
  if (asked.length === 0) return []
  return slugs
    .map((slug, index) => {
      const words = slugWords(slug)
      const shared = asked.filter((word) => words.some((other) => sameWord(word, other))).length
      return { slug, index, shared, extra: words.length - shared }
    })
    .filter((candidate) => candidate.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.extra - b.extra || a.index - b.index)
    .slice(0, max)
    .map((candidate) => candidate.slug)
}

export type { Skill, SkillTier } from '@/lib/agent-skills/types'
export { SKILL_MIME_TYPE, SKILL_URI_PREFIX, skillUri, skillSlugFromUri } from '@/lib/agent-skills/types'
export { loadAtomsAsSkills, toSummary, __resetAtomCache } from '@/lib/agent-skills/atoms'
