import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { loadCompanySkillRows } from '@/lib/agent-skills/company-skills'
import { UpdateCompanySkillSchema } from '@/lib/agent-skills/validation'
import { COMMUNITY_OPEN } from '@/lib/agent-skills/agents'
import { notifyReviewersOfSubmission } from '@/lib/agent-skills/community-notify'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { getCanonicalAppOrigin } from '@/lib/domains/trusted-app-origin'
import { ensureInitialized } from '@/lib/init'
import { createLogger } from '@/lib/logger'

ensureInitialized()
const log = createLogger('api/skills')
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
  // COMMUNITY_OPEN is the switch for new shares; withdrawing always works.
  if (input.action === 'submit' && !COMMUNITY_OPEN) return failure(403, 'FORBIDDEN', 'Delning till community är inte öppen än.', 'Sharing with the community is not open yet.')
  if (input.action === 'add' && !row.draft) return failure(409, 'CONFLICT', 'Skillen är redan tillagd.', 'The skill is already added.')
  if (input.action !== 'withdraw' && input.action !== 'add' && row.share_status !== 'private') return failure(409, 'CONFLICT', 'Inskickad text är låst för granskning.', 'Submitted content is frozen for review.')
  if (input.action === 'withdraw' && !['submitted', 'published'].includes(row.share_status)) return failure(409, 'CONFLICT', 'Skillen är inte inskickad.', 'The skill is not submitted.')
  const update = input.action === 'edit'
    ? supabase.from('company_skills').update({ name: input.name, description: input.description, body: input.body })
    : input.action === 'submit'
      ? supabase.from('company_skills').update({
        share_status: 'submitted', author_handle: input.author_handle, share_confirmed_at: new Date().toISOString(),
        // The author may still say what kind of item it is; frozen with the submission.
        ...(input.kind ? { kind: input.kind } : {}),
      })
      : input.action === 'add'
        ? supabase.from('company_skills').update({ draft: false })
        // Withdrawing makes it private again; the database drops the review evidence and hides a published text from every AI.
        : supabase.from('company_skills').update({ share_status: 'private' })
  const scoped = row.team_id ? update.eq('team_id', row.team_id) : update.eq('company_id', companyId)
  const { data, error } = await scoped.eq('id', id).eq('share_status', row.share_status).select('id').maybeSingle()
  if (error) throw error
  if (!data) return failure(409, 'CONFLICT', 'Skillen ändrades eller behörighet saknas. Ladda om.', 'Skill changed or permission is missing. Reload.')
  if (input.action === 'submit') {
    // Accounted's reviewers hear about it; the share is saved either way. The
    // link is always the canonical app: the request's host is not trusted in an email.
    const reviewUrl = `${getCanonicalAppOrigin()}/skills/granskning`
    const submission = { title: row.name ?? '', handle: input.author_handle, kind: input.kind ?? row.kind ?? 'workflow' }
    after(() => notifyReviewersOfSubmission(createServiceClientNoCookies(), submission, reviewUrl))
  }
  return NextResponse.json({ data })
}, { requireWrite: true })

export const DELETE = withRouteContext<Params>('skills.delete', async (_request, { supabase, companyId }, { params }) => {
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return failure(400, 'VALIDATION_ERROR', 'Ogiltigt skill-id.', 'Invalid skill ID.')
  const row = (await loadCompanySkillRows(supabase, companyId)).find((item) => item.id === id)
  if (!row) return failure(404, 'NOT_FOUND', 'Skillen hittades inte.', 'Skill not found.')
  if (row.share_status !== 'private') return failure(409, 'CONFLICT', 'Dra tillbaka delningen först.', 'Withdraw the sharing first.')
  const deletion = supabase.from('company_skills').delete().eq('id', id).eq('share_status', 'private')
  const scoped = row.team_id ? deletion.eq('team_id', row.team_id) : deletion.eq('company_id', companyId)
  const { data, error } = await scoped.select('id').maybeSingle()
  if (error) throw error
  if (!data) return failure(403, 'FORBIDDEN', 'Behörighet saknas.', 'Permission denied.')
  // The knowledge chosen for this flow goes with it. The instruction is gone
  // whatever happens here, so a failed clean-up is logged, not surfaced.
  const choices = supabase.from('company_agent_knowledge').delete().eq('agent_id', `own/${id}`)
  const { error: choicesError } = await (row.team_id ? choices : choices.eq('company_id', companyId))
  if (choicesError) log.warn('Knowledge choices of a deleted own flow were left behind', { skillId: id, error: choicesError.message })
  return NextResponse.json({ data })
}, { requireWrite: true })
