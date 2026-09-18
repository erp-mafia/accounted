import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { loadCompanySkillRows } from '@/lib/agent-skills/company-skills'
import { UpdateCompanySkillSchema } from '@/lib/agent-skills/validation'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()
type Params = { params: Promise<{ id: string }> }
const failure = (status: number, code: string, message: string, message_en: string) => NextResponse.json({ error: { code, message, message_en } }, { status })

export const PATCH = withRouteContext<Params>('skills.update', async (request, { supabase, companyId }, { params }) => {
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return failure(400, 'VALIDATION_ERROR', 'Ogiltigt skill-id.', 'Invalid skill ID.')
  const validation = await validateBody(request, UpdateCompanySkillSchema)
  if (!validation.success) return validation.response
  const row = (await loadCompanySkillRows(supabase, companyId)).find((item) => item.id === id)
  if (!row || row.atom_id) return failure(404, 'NOT_FOUND', 'Egen skill hittades inte.', 'Own skill not found.')
  const input = validation.data
  if (input.action !== 'withdraw' && row.share_status !== 'private') return failure(409, 'CONFLICT', 'Inskickad text är låst för granskning.', 'Submitted content is frozen for review.')
  if (input.action === 'withdraw' && !['submitted', 'published'].includes(row.share_status)) return failure(409, 'CONFLICT', 'Skillen är inte inskickad.', 'The skill is not submitted.')
  const update = input.action === 'edit'
    ? supabase.from('company_skills').update({ name: input.name, description: input.description, body: input.body })
    : input.action === 'submit'
      ? supabase.from('company_skills').update({ share_status: 'submitted', author_handle: input.author_handle, share_confirmed_at: new Date().toISOString() })
      : supabase.from('company_skills').update({ share_status: 'withdrawn' })
  const scoped = row.team_id ? update.eq('team_id', row.team_id) : update.eq('company_id', companyId)
  const { data, error } = await scoped.eq('id', id).eq('share_status', row.share_status).select('id').maybeSingle()
  if (error) throw error
  if (!data) return failure(409, 'CONFLICT', 'Skillen ändrades eller behörighet saknas. Ladda om.', 'Skill changed or permission is missing. Reload.')
  return NextResponse.json({ data })
}, { requireWrite: true })

export const DELETE = withRouteContext<Params>('skills.delete', async (_request, { supabase, companyId }, { params }) => {
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return failure(400, 'VALIDATION_ERROR', 'Ogiltigt skill-id.', 'Invalid skill ID.')
  const row = (await loadCompanySkillRows(supabase, companyId)).find((item) => item.id === id)
  if (!row) return failure(404, 'NOT_FOUND', 'Skillen hittades inte.', 'Skill not found.')
  if (row.share_status !== 'private') return failure(409, 'CONFLICT', 'Dra tillbaka delningen före borttagning. Granskaren slutför återkallelsen.', 'Withdraw sharing first. The reviewer must finish the withdrawal.')
  const deletion = supabase.from('company_skills').delete().eq('id', id).eq('share_status', 'private')
  const scoped = row.team_id ? deletion.eq('team_id', row.team_id) : deletion.eq('company_id', companyId)
  const { data, error } = await scoped.select('id').maybeSingle()
  if (error) throw error
  if (!data) return failure(403, 'FORBIDDEN', 'Behörighet saknas.', 'Permission denied.')
  return NextResponse.json({ data })
}, { requireWrite: true })
