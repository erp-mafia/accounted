import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'

const SetNoDocSchema = z.object({
  reason: z.string().trim().max(200).nullable().optional(),
})

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.no_doc_required.set',
  async (request, { supabase, companyId, user }, { params }) => {
  const { id } = await params

  const result = await validateBody(request, SetNoDocSchema)
  if (!result.success) return result.response

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (entryError || !entry) {
    return NextResponse.json({ error: 'Verifikationen hittades inte.' }, { status: 404 })
  }

  const { error } = await supabase
    .from('journal_entry_no_doc_required')
    .upsert(
      {
        journal_entry_id: id,
        company_id: companyId,
        user_id: user.id,
        reason: result.data.reason ?? null,
      },
      { onConflict: 'journal_entry_id' }
    )

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ data: { exempted: true } })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.no_doc_required.unset',
  async (_request, { supabase, companyId }, { params }) => {
  const { id } = await params

  // Authorization is company-scoped, not user-scoped: any non-viewer member
  // of the active company may revoke any exemption in that company. The flag
  // is a shared bookkeeping artefact (same model as booking_template_library,
  // mapping_rules, etc.): exemptions are reviewed as a team. The audit_log
  // trigger captures the DELETE with actor_id so accountability is preserved.
  const { error } = await supabase
    .from('journal_entry_no_doc_required')
    .delete()
    .eq('journal_entry_id', id)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ data: { exempted: false } })
  },
  { requireWrite: true },
)
