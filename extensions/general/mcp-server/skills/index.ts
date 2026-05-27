import type { SupabaseClient } from '@supabase/supabase-js'
import type { Skill } from './types'
import { monthEndCloseSkill } from './month-end-close'
import { quarterlyVatReviewSkill } from './quarterly-vat-review'
import { yearEndCloseSkill } from './year-end-close'
import { invoicingRulesSkill } from './invoicing-rules'
import { payrollMonthlySkill } from './payroll-monthly'
import { bankReconciliationSkill } from './bank-reconciliation'
import { kreditfakturaProcessSkill } from './kreditfaktura-process'
import { customerOnboardingSkill } from './customer-onboarding'
import { loadAtomsAsSkills, loadReferenceById } from './atoms'

/** Static workflow skills the server ships with. Tier: 'workflow'. */
export const workflowSkills: Skill[] = [
  monthEndCloseSkill,
  quarterlyVatReviewSkill,
  yearEndCloseSkill,
  invoicingRulesSkill,
  payrollMonthlySkill,
  bankReconciliationSkill,
  kreditfakturaProcessSkill,
  customerOnboardingSkill,
]

/** @deprecated Use `workflowSkills` for the static set, or `loadAllSkills(supabase)`
 *  for the unified list (workflows + atoms). Kept for backwards compatibility
 *  with prior imports. */
export const skills = workflowSkills

/**
 * Resolve a skill by slug. Checks the static workflow array first (synchronous,
 * always available), then falls back to the registry-backed atom set
 * (asynchronous, supabase-bound).
 */
export async function findSkill(slug: string, supabase?: SupabaseClient): Promise<Skill | null> {
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
export async function loadAllSkills(supabase: SupabaseClient): Promise<Skill[]> {
  const atoms = await loadAtomsAsSkills(supabase)
  return [...workflowSkills, ...atoms]
}

export type { Skill, SkillTier } from './types'
export { SKILL_MIME_TYPE, SKILL_URI_PREFIX, skillUri, skillSlugFromUri } from './types'
export { loadAtomsAsSkills, __resetAtomCache } from './atoms'
