import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'

const UpdateNotesSchema = z.object({
  notes: z.string().max(2000).nullable(),
})

// Notes are annotation metadata alongside the verifikat (not räkenskaps-
// information) — the immutability trigger governs what may change on posted
// entries; this route just scopes and validates.
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.notes',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const result = await validateBody(request, UpdateNotesSchema)
    if (!result.success) return result.response

    const { data, error } = await supabase
      .from('journal_entries')
      .update({ notes: result.data.notes })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id')
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    // Zero rows = the entry doesn't exist in this company — report it instead
    // of a phantom success.
    if (!data) {
      return NextResponse.json({ error: 'Verifikationen hittades inte.' }, { status: 404 })
    }

    return NextResponse.json({ data: { updated: true } })
  },
  { requireWrite: true },
)
