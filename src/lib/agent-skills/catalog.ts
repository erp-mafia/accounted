import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAtomsAsSkills, loadReferenceById } from './atoms'
import { loadCompanySkillRows, ownSkill, type CompanySkillRow } from './company-skills'
import { workflowSkills } from './workflows'
import { kvittojaktenSkills } from './workflows/kvittojakten'
import type { Skill } from './types'

export interface CatalogSkill extends Skill {
  active: boolean
  installations: Array<{ installation_id: string; scope: 'company' | 'team' }>
  shareStatus?: CompanySkillRow['share_status']
  /** A published own item: its public page. */
  publishedUrl?: string | null
  /** A shared own item Accounted sent back, and why. */
  reviewNote?: string | null
  /** Saved by an AI, waiting for a person to add it on the Skills page. */
  draft?: boolean
}

export async function loadSkillCatalog(supabase: SupabaseClient, companyId: string): Promise<CatalogSkill[]> {
  const [atoms, rows, profileResult] = await Promise.all([
    loadAtomsAsSkills(supabase), loadCompanySkillRows(supabase, companyId),
    supabase.from('agent_profiles').select('vertical_atoms, modifier_atoms').eq('company_id', companyId).maybeSingle(),
  ])
  if (profileResult.error) throw profileResult.error
  const profile = profileResult.data
  const selected = new Set<string>([...(profile?.vertical_atoms ?? []), ...(profile?.modifier_atoms ?? [])])
  return [
    ...[...workflowSkills, ...atoms].map((skill): CatalogSkill => {
      const installs = rows.filter((row) => row.atom_id === skill.slug)
      return {
        ...skill,
        source: skill.tier === 'community' ? 'community' : 'accounted',
        active: skill.tier === 'horizontal' || skill.tier === 'workflow' || selected.has(skill.slug) || installs.length > 0,
        installations: installs.map((row) => ({ installation_id: row.id, scope: row.team_id ? 'team' : 'company' })),
      }
    }),
    ...rows.flatMap((row): CatalogSkill[] => {
      const skill = ownSkill(row)
      // Withdrawn submissions and AI-saved drafts remain visible in the UI,
      // but are never returned as active or loadable to an AI.
      if (!skill && (row.atom_id || !row.name || !row.body)) return []
      return [{
        ...(skill ?? { slug: `own/${row.id}`, name: row.name!, summary: row.description ?? '', body: row.body!, tags: ['own'], tier: 'own' as const, source: 'own' as const, itemKind: row.kind ?? 'workflow' }),
        active: row.share_status !== 'withdrawn' && !row.draft, shareStatus: row.share_status,
        ...(row.share_status === 'published' && row.published_atom_id ? { publishedUrl: `https://accounted.se/instruktioner/${row.published_atom_id.replace(/^community\//, '')}` } : {}),
        ...(row.share_status === 'private' && row.review_note ? { reviewNote: row.review_note } : {}),
        ...(row.draft ? { draft: true } : {}),
        installations: [{ installation_id: row.id, scope: row.team_id ? 'team' : 'company' }],
      }]
    }),
  ]
}

/** includeInactive: the Skills page may read withdrawn skills and drafts; an agent never may. */
export async function loadCatalogSkill(supabase: SupabaseClient, companyId: string, slug: string, includeInactive = false): Promise<Skill | null> {
  const catalog = await loadSkillCatalog(supabase, companyId)
  const skill = catalog.find((item) => item.slug === slug)
  if (skill) return (skill.shareStatus === 'withdrawn' || skill.draft) && !includeInactive ? null : skill
  // Kvittojakten is not listed (one body per client), but each body loads by its slug.
  const kvittojakten = kvittojaktenSkills.find((item) => item.slug === slug)
  if (kvittojakten) return kvittojakten
  return slug.startsWith('own/') ? null : loadReferenceById(supabase, slug)
}
