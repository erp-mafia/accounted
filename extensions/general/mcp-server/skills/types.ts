/**
 * Skills over MCP — domain-knowledge bodies the server ships alongside tools.
 *
 * Two flavors live behind the same interface:
 *
 *  - **workflow** skills are static Markdown documents the server ships
 *    alongside tools (month-end close, VAT review, year-end, invoicing,
 *    payroll). They document *how* to compose gnubok tools for a real-world
 *    workflow.
 *  - **horizontal / vertical / modifier** atoms are loaded dynamically from
 *    `agent_atom_registry` — the same atoms the in-app composer assembles for
 *    a company. Exposing them here gives Claude.ai parity with the in-app
 *    surface (plan §13 MCP parity).
 *
 * Agents call `gnubok_list_skills` to discover, then `gnubok_load_skill(slug)`
 * to read a single body. Atom slugs match their registry id verbatim
 * (e.g. "vertical/konsult-it", "modifier/holding-ab").
 *
 * Forward-compatible: when MCP adds a native `skills/list` primitive, the
 * Skill interface and bodies migrate without changes.
 */

export type SkillTier = 'workflow' | 'horizontal' | 'vertical' | 'modifier'

/**
 * Pre-conditions a skill needs to be relevant to a company. `gnubok_list_skills`
 * filters out skills whose applicability doesn't match the current company by
 * default — agents get a focused list. Pass `include_all: true` on the tool
 * call to bypass the filter when needed.
 *
 * Each condition is optional and ANDed:
 *  - `entity_type: 'AB'` hides the skill for sole traders (EF)
 *  - `entity_type: 'EF'` hides it for limited companies
 *  - `requires: ['employees']` hides the skill until the company has ≥ 1 employee
 *  - `requires: ['vat_registered']` hides it for non-VAT-registered companies
 *
 * Workflow skills that are universal (e.g. invoicing-rules) leave applicability
 * undefined and are always shown.
 */
export interface SkillApplicability {
  entity_type?: 'AB' | 'EF' | 'both'
  requires?: ('employees' | 'vat_registered')[]
}

export interface Skill {
  /** URL-safe id, used in tool args and resource URIs. Workflow skills use a
   *  flat slug ("month-end-close"); atoms use their tier-prefixed registry id
   *  ("vertical/konsult-it"). */
  slug: string
  /** Display name (e.g. "Month-End Close"). */
  name: string
  /** One-line summary used by gnubok_list_skills. */
  summary: string
  /** Tags for filtering (e.g. ['monthly', 'vat', 'reconciliation']). */
  tags: string[]
  /** Full skill body as Markdown. */
  body: string
  /** Where the skill comes from — static workflow or a registry-loaded atom. */
  tier: SkillTier
  /** Optional company-context filter applied by gnubok_list_skills. */
  applicability?: SkillApplicability
}

export const SKILL_MIME_TYPE = 'text/markdown' as const

/** Resource URI prefix for skills exposed via resources/read. */
export const SKILL_URI_PREFIX = 'gnubok://skill/' as const

/** Build a resource URI for a skill. Slugs with slashes (atom ids) are
 *  URL-encoded so the URI remains well-formed. */
export function skillUri(slug: string): string {
  return `${SKILL_URI_PREFIX}${encodeURIComponent(slug)}`
}

export function skillSlugFromUri(uri: string): string | null {
  if (!uri.startsWith(SKILL_URI_PREFIX)) return null
  const raw = uri.slice(SKILL_URI_PREFIX.length)
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
