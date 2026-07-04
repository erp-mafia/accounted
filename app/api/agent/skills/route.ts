import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getActiveCompanyId } from '@/lib/company/context'

// GET /api/agent/skills
//
// Read-only transparency surface for the in-app bookkeeping assistant's domain
// knowledge ("atoms"). Powers /settings/agent-skills: the companion to
// /settings/agent-memory. Memory is what the assistant *learned* about this
// company (user-editable); skills are the Swedish-accounting expertise it
// *ships* with: authored in .claude/skills/**/SKILL.md, seeded into
// agent_atom_registry, read-only for users, curated via mcp_exposed.
//
// Two shapes off one route:
//   (no params) → metadata for every active + exposed atom, each flagged
//                 active-for-this-company. Bodies omitted so the list payload
//                 stays small.
//   ?slug=<id>  → the full SKILL.md body for one atom, loaded on expand.
//
// "Active for this company": horizontal atoms are regulatory and shared by
// every Swedish company, so always active. Vertical/modifier atoms are active
// only when the composer selected them into this company's agent_profile:
// others are shown dormant so the user sees both the full library and what's
// tuned for them. The profile arrays store full ids ("vertical/konsult-it"),
// matched directly against agent_atom_registry.id (see lib/agent/chat/system-prompt.ts).

interface AtomMeta {
  id: string
  tier: 'horizontal' | 'vertical' | 'modifier'
  title: string
  description: string
  active: boolean
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) return NextResponse.json({ error: 'No active company' }, { status: 400 })

  const url = new URL(request.url)
  const slug = url.searchParams.get('slug')

  // Detail: one atom's body, fetched lazily when the user expands a card.
  if (slug) {
    const { data, error } = await supabase
      .from('agent_atom_registry')
      .select('id, title, body, is_active, mcp_exposed')
      .eq('id', slug)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || !data.is_active || !data.mcp_exposed) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ data: { id: data.id, title: data.title, body: data.body ?? '' } })
  }

  // List: metadata for every visible atom + which are active for this company.
  const { data: atoms, error } = await supabase
    .from('agent_atom_registry')
    .select('id, tier, title, description')
    .eq('is_active', true)
    .eq('mcp_exposed', true)
    .is('parent_atom_id', null) // show top-level skills only; reference children are internal
    .order('tier', { ascending: true })
    .order('title', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: profile } = await supabase
    .from('agent_profiles')
    .select('vertical_atoms, modifier_atoms')
    .eq('company_id', companyId)
    .maybeSingle()

  const verticalActive = new Set((profile?.vertical_atoms as string[] | null) ?? [])
  const modifierActive = new Set((profile?.modifier_atoms as string[] | null) ?? [])

  const result: AtomMeta[] = (atoms ?? []).map((a) => {
    const tier = a.tier as AtomMeta['tier']
    const active =
      tier === 'horizontal'
        ? true
        : tier === 'vertical'
          ? verticalActive.has(a.id)
          : modifierActive.has(a.id)
    return { id: a.id, tier, title: a.title, description: a.description, active }
  })

  return NextResponse.json({ data: result })
}
