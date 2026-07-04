import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'

const SetNoDocSchema = z.object({
  reason: z.string().trim().max(200).nullable().optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

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
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

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
}
