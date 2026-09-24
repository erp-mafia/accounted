import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { loadCatalogSkill, loadSkillCatalog } from '@/lib/agent-skills/catalog'
import { CreateCompanySkillSchema } from '@/lib/agent-skills/validation'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

const QuerySchema = z.object({ slug: z.string().min(1).max(250).optional() }).strict()

export const GET = withRouteContext('skills.list', async (request, { supabase, companyId }) => {
  const query = validateQuery(request, QuerySchema)
  if (!query.success) return query.response
  if (query.data.slug) {
    const skill = await loadCatalogSkill(supabase, companyId, query.data.slug, true)
    if (!skill) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Skillen hittades inte.', message_en: 'Skill not found.' } }, { status: 404 })
    return NextResponse.json({ data: skill }, { headers: { 'Cache-Control': 'private, no-store' } })
  }
  const skills = await loadSkillCatalog(supabase, companyId)
  return NextResponse.json({ data: skills.map(({ body: _body, ...skill }) => skill) }, { headers: { 'Cache-Control': 'private, no-store' } })
})

export const POST = withRouteContext('skills.create', async (request, { supabase, companyId, user }) => {
  const validation = await validateBody(request, CreateCompanySkillSchema)
  if (!validation.success) return validation.response
  const input = validation.data
  let teamId: string | null = null
  if (input.scope === 'team') {
    const { data: company, error } = await supabase.from('companies').select('team_id').eq('id', companyId).single()
    if (error) throw error
    if (!company?.team_id) return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Företaget tillhör ingen byrå.', message_en: 'The company has no team.' } }, { status: 400 })
    const { data: membership, error: memberError } = await supabase.from('team_members').select('role').eq('team_id', company.team_id).eq('user_id', user.id).maybeSingle()
    if (memberError) throw memberError
    if (!membership || !['owner', 'admin'].includes(membership.role)) return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Endast byråns administratörer kan ändra gemensamma skills.', message_en: 'Only team administrators may change shared skills.' } }, { status: 403 })
    teamId = company.team_id
  }
  if (input.kind === 'catalog') {
    const { data: atom, error } = await supabase.from('agent_atom_registry').select('id, tier').eq('id', input.atom_id).eq('is_active', true).eq('mcp_exposed', true).is('parent_atom_id', null).maybeSingle()
    if (error) throw error
    if (!atom) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Skillen hittades inte.', message_en: 'Skill not found.' } }, { status: 404 })
    if (atom.tier === 'horizontal') return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Denna skill är alltid aktiv.', message_en: 'This skill is always enabled.' } }, { status: 400 })
  }
  const { data, error } = await supabase.from('company_skills').insert({
    company_id: teamId ? null : companyId, team_id: teamId, created_by: user.id,
    atom_id: input.kind === 'catalog' ? input.atom_id : null,
    name: input.kind === 'own' ? input.name : null,
    description: input.kind === 'own' ? input.description : null,
    body: input.kind === 'own' ? input.body : null,
  }).select('id').single()
  if (error?.code === '23505') return NextResponse.json({ error: { code: 'CONFLICT', message: 'Skillen är redan tillagd.', message_en: 'Skill already added.' } }, { status: 409 })
  if (error) throw error
  return NextResponse.json({ data }, { status: 201 })
}, { requireWrite: true })
