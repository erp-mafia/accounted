import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { Skill } from './types'

export interface CompanySkillRow {
  id: string
  company_id: string | null
  team_id: string | null
  atom_id: string | null
  name: string | null
  description: string | null
  body: string | null
  share_status: 'private' | 'submitted' | 'published' | 'withdrawn'
  created_by: string
  updated_at: string
  reviewed_at: string | null
  published_atom_id: string | null
  /** Saved by an AI and not yet added by a person: listed, never loadable. */
  draft?: boolean
}

/** Caller must already authorize company membership. Never cache tenant data. */
export async function loadCompanySkillRows(supabase: SupabaseClient, companyId: string): Promise<CompanySkillRow[]> {
  const { data: company, error } = await supabase.from('companies').select('team_id').eq('id', companyId).maybeSingle()
  if (error) throw error
  const [own, team] = await Promise.all([
    fetchAllRows<CompanySkillRow>((range) => supabase.from('company_skills').select('*')
      .eq('company_id', companyId).order('id').range(range.from, range.to)),
    company?.team_id ? fetchAllRows<CompanySkillRow>((range) => supabase.from('company_skills').select('*')
      .eq('team_id', company.team_id).order('id').range(range.from, range.to)) : Promise.resolve([]),
  ])
  return [...team, ...own]
}

export function ownSkill(row: CompanySkillRow): Skill | null {
  if (row.atom_id || row.share_status === 'withdrawn' || row.draft || !row.name || !row.body) return null
  return {
    slug: `own/${row.id}`, name: row.name, summary: row.description ?? '',
    body: row.body, tags: ['own'], tier: 'own', source: 'own', reviewedAt: row.reviewed_at,
  }
}

export async function resolveOwnSkill(supabase: SupabaseClient, companyId: string, slug: string): Promise<Skill | null> {
  if (!slug.startsWith('own/')) return null
  const rows = await loadCompanySkillRows(supabase, companyId)
  const row = rows.find((item) => `own/${item.id}` === slug)
  return row ? ownSkill(row) : null
}
