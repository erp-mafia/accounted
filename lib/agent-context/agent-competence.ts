import type { SupabaseClient } from '@supabase/supabase-js'

// Server-side read of the agent's competence (the domain-knowledge "atoms" it
// ships with) and its top learned facts (memory), for the read-only overview
// on the "Vad din agent vet" page. Mirrors GET /api/agent/skills and
// GET /api/agent/memory so the two surfaces stay consistent; the full editable
// management lives in /settings/assistant.

export type AtomTier = 'horizontal' | 'vertical' | 'modifier'

export interface AgentAtom {
  id: string
  tier: AtomTier
  title: string
  description: string
  /** horizontal atoms apply to every company; vertical/modifier only when the
   *  composer selected them into this company's profile. */
  active: boolean
}

export type FactKind = 'fact' | 'preference' | 'pattern' | 'correction'
export type FactSource = 'composer' | 'user_taught' | 'agent_learned' | 'derived'

export interface AgentFact {
  id: string
  kind: FactKind
  content: string
  source: FactSource
  is_pinned: boolean
}

export interface AgentCompetence {
  atoms: AgentAtom[]
  facts: AgentFact[]
  /** Total active facts (before the overview cap), so the count is honest. */
  factsActiveTotal: number
}

const FACTS_LIMIT = 12

export async function buildAgentCompetence(
  supabase: SupabaseClient,
  companyId: string,
): Promise<AgentCompetence> {
  const [atomsRes, profileRes, factsRes, factsCountRes] = await Promise.all([
    // The atom registry is global product content, not tenant data.
    supabase
      .from('agent_atom_registry')
      .select('id, tier, title, description')
      .eq('is_active', true)
      .eq('mcp_exposed', true)
      .is('parent_atom_id', null)
      .order('tier', { ascending: true })
      .order('title', { ascending: true }),
    supabase
      .from('agent_profiles')
      .select('vertical_atoms, modifier_atoms')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('agent_memory')
      .select('id, kind, content, source, is_pinned')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('is_pinned', { ascending: false })
      .order('relevance_score', { ascending: false })
      .order('last_accessed_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(FACTS_LIMIT),
    supabase
      .from('agent_memory')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('is_active', true),
  ])

  if (atomsRes.error) throw new Error(`agent skills failed: ${atomsRes.error.message}`)
  if (factsRes.error) throw new Error(`agent memory failed: ${factsRes.error.message}`)

  const verticalActive = new Set((profileRes.data?.vertical_atoms as string[] | null) ?? [])
  const modifierActive = new Set((profileRes.data?.modifier_atoms as string[] | null) ?? [])

  const atoms: AgentAtom[] = (atomsRes.data ?? []).map((a) => {
    const tier = a.tier as AtomTier
    const active =
      tier === 'horizontal' ? true : tier === 'vertical' ? verticalActive.has(a.id) : modifierActive.has(a.id)
    return { id: a.id, tier, title: a.title, description: a.description, active }
  })

  const facts: AgentFact[] = (factsRes.data ?? []).map((f) => ({
    id: f.id,
    kind: f.kind as FactKind,
    content: f.content,
    source: f.source as FactSource,
    is_pinned: f.is_pinned,
  }))

  return { atoms, facts, factsActiveTotal: factsCountRes.count ?? facts.length }
}
