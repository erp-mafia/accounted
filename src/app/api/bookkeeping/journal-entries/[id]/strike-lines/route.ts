import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { StrikeLinesSchema } from '@/lib/api/schemas'
import { strikeJournalEntryLines } from '@/lib/core/bookkeeping/journal-entry-corrections'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/bookkeeping/journal-entries/[id]/strike-lines
 *
 * Inline line rättelse (BFL 5 kap 5 §): strike lines inside a POSTED
 * verifikat and add replacement lines in the same verifikat, without a
 * rättelseverifikation. The correct_entry_lines_inline RPC enforces the full
 * envelope (posted status, open/unlocked period, company lock date, effective
 * balance to the öre, at least 2 remaining lines, writer role) and snapshots
 * the struck originals to the immutable journal_entry_rattelse_log. Past a
 * lock/close, the storno correction flow remains the only path. The rules
 * live in lib/core/bookkeeping/journal-entry-corrections.ts, shared with the
 * v1 operation journal-entries.strike-lines and gnubok_correct_entry_lines.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.strike_lines',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, StrikeLinesSchema)
    if (!validation.success) return validation.response

    const outcome = await strikeJournalEntryLines(
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
