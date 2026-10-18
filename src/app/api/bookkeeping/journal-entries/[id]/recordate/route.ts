import { NextResponse } from 'next/server'
import { redateJournalEntry } from '@/lib/core/bookkeeping/journal-entry-corrections'
import { validateBody } from '@/lib/api/validate'
import { RecordateJournalEntrySchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { linkBasisColumns } from '@/lib/links/stamp'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/bookkeeping/journal-entries/[id]/recordate
 *
 * Move a posted verifikat to another date by storno + re-post
 * (recordateEntry). Shared with the v1 operation journal-entries.redate and
 * gnubok_redate_entry through lib/core/bookkeeping/journal-entry-corrections.ts.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.recordate',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, RecordateJournalEntrySchema)
    if (!validation.success) return validation.response
    // The posting port's events, while POSTING_EVENTS is on: the person moved the verifikat.
    const outcome = await redateJournalEntry({ supabase, companyId, userId: user.id, log }, id, validation.data, {
      posting: () => ({ linkBasis: linkBasisColumns('user_created') }),
    })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
