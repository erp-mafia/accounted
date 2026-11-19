import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { setJournalEntryNote } from '@/lib/core/bookkeeping/journal-entry-edits'
import { sessionFailureResponse } from '@/lib/operations/session'

const UpdateNotesSchema = z.object({
  notes: z.string().max(2000).nullable(),
})

// Notes are annotation metadata alongside the verifikat (not räkenskaps-
// information): the immutability trigger governs what may change on posted
// entries. Rules in lib/core/bookkeeping/journal-entry-edits.ts, shared with
// the v1 operation journal-entries.set-note.
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.notes',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const result = await validateBody(request, UpdateNotesSchema)
    if (!result.success) return result.response

    const outcome = await setJournalEntryNote({ supabase, companyId, userId: user.id, log }, id, result.data.notes)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)

    return NextResponse.json({ data: { updated: true } })
  },
  { requireWrite: true },
)
