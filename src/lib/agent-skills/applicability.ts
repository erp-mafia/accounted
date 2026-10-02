import type { EntityType } from '@/types'
import { byEntityType, isEntityType } from '@/lib/company/entity-type'
import type { SkillApplicability } from './types'

/** What `skillAppliesToCompany` needs to know about the company. */
export interface SkillCompanyContext {
  /**
   * The company's legal form as stored (`company_settings.entity_type`:
   * `aktiebolag`, `enskild_firma`, `ideell_forening`). Null or an unknown
   * value means the form is unresolved: the entity condition is then not
   * applied, so a misconfigured company still sees the skill.
   */
  entityType: unknown
  hasEmployees: boolean
  vatRegistered: boolean
}

type SkillFormTag = Exclude<NonNullable<SkillApplicability['entity_type']>, 'both'>

/**
 * The `SkillApplicability.entity_type` tag a legal form answers to.
 *
 * Skills are tagged with the short codes 'AB' and 'EF'; companies store the
 * form's DB code. Comparing the two directly never matched, so every AB-only
 * or EF-only skill was hidden from every company. The dispatch is exhaustive
 * over the legal-form registry, so a new form does not compile until it says
 * which tag, if any, it answers to.
 *
 * An ideell förening is neither an aktiebolag nor an enskild firma (members
 * instead of owners, its own equity accounts and filings), so it answers to
 * no tag: a skill written for AB or EF only stays hidden for it, while a skill
 * tagged 'both' or without an entity condition shows for it as for every form.
 */
function skillFormTag(entityType: EntityType): SkillFormTag | null {
  return byEntityType<SkillFormTag | null>(entityType, {
    aktiebolag: 'AB',
    enskild_firma: 'EF',
    ideell_forening: null,
  })
}

function appliesToEntityType(tag: SkillApplicability['entity_type'], entityType: unknown): boolean {
  if (!tag || tag === 'both') return true
  if (!isEntityType(entityType)) return true
  return skillFormTag(entityType) === tag
}

/**
 * Whether a skill's applicability matches the company. Every condition is
 * optional and ANDed; a skill without applicability applies everywhere. The
 * one place that evaluates `SkillApplicability`: `gnubok_list_skills` filters
 * through it.
 */
export function skillAppliesToCompany(
  applicability: SkillApplicability | null | undefined,
  company: SkillCompanyContext,
): boolean {
  if (!applicability) return true
  if (!appliesToEntityType(applicability.entity_type, company.entityType)) return false
  if (applicability.requires?.includes('employees') && !company.hasEmployees) return false
  if (applicability.requires?.includes('vat_registered') && !company.vatRegistered) return false
  return true
}
