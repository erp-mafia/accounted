import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'

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

const QuerySchema = z.object({
  slug: z.string().min(1).optional(),
})

export const GET = withRouteContext('agent.skills.list', async (request, ctx) => {
  const { supabase, companyId, log } = ctx

  const validated = validateQuery(request, QuerySchema, {
    log,
    operation: 'agent.skills.list',
  })
  if (!validated.success) return validated.response
  const { slug } = validated.data

  // Detail: one atom's body, fetched lazily when the user expands a card.
  // The atom registry is global product content (not tenant data), so no
  // company filter applies here.
  if (slug) {
    const { data, error } = await supabase
      .from('agent_atom_registry')
      .select('id, title, body, is_active, mcp_exposed')
      .eq('id', slug)
      .maybeSingle()
    if (error) throw error
    if (!data || !data.is_active || !data.mcp_exposed) {
      return NextResponse.json(
        {
          error: {
            code: 'SKILL_NOT_FOUND',
            message: 'Kunskapen hittades inte.',
            message_en: 'Skill not found.',
          },
        },
        { status: 404 },
      )
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
  if (error) throw error

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
})
