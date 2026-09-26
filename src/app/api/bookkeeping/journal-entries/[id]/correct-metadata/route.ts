import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CorrectEntryMetadataSchema } from '@/lib/api/schemas'
import { correctJournalEntryMetadata } from '@/lib/core/bookkeeping/journal-entry-corrections'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/bookkeeping/journal-entries/[id]/correct-metadata
 *
 * Metadata rättelse (BFL 5 kap 9 §): correct the description and/or the
 * entry date (within the same fiscal period) of a POSTED verifikat, without
 * a rättelseverifikation. The correct_entry_metadata RPC enforces everything
 * (posted status, open/unlocked period, company lock date, same-period date,
 * writer role) and writes the immutable journal_entry_rattelse_log row
 * before the carve-out UPDATE. Cross-period date moves stay on the
 * recordate (storno) flow. The rules live in
 * lib/core/bookkeeping/journal-entry-corrections.ts, shared with the v1
 * operation journal-entries.correct-metadata and gnubok_correct_entry_metadata.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.correct_metadata',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, CorrectEntryMetadataSchema)
    if (!validation.success) return validation.response

    const outcome = await correctJournalEntryMetadata(
      { supabase, companyId, userId: user.id, log },
      id,
      validation.data,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
