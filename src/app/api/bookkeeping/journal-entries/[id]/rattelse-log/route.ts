import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { getJournalEntryRattelseLog } from '@/lib/core/bookkeeping/journal-entry-corrections'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * GET /api/bookkeeping/journal-entries/[id]/rattelse-log
 *
 * The entry's inline rättelse history (BFL 5 kap 5 § / 9 §): the immutable
 * who/when trail behind every metadata edit and line strike, newest first.
 * Struck lines render with strikethrough in the verifikat detail view from
 * the struck_lines snapshots here. Each row also carries `actor_label`, the
 * actor's profile label, so the page can say who struck a line without the
 * reader opening a log panel; the raw `actor` uuid is kept unchanged.
 * Rows with source='sie_import' are correction history carried by the
 * imported SIE file (#BTRANS/#RTRANS, #2427): no actor, `external_signature`
 * names who corrected in the source system. Shared with the v1 operation
 * journal-entries.rattelse-log through
 * lib/core/bookkeeping/journal-entry-corrections.ts.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.rattelse_log',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    // `profiles` RLS is self-only, so the label lookup goes through the
    // service client, scoped to exactly the actor ids that already appear in
    // this company's own log rows (same precedent as behandlingshistorik).
    const outcome = await getJournalEntryRattelseLog(
      { supabase, companyId, userId: user.id, log },
      id,
      () => createServiceClient(),
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
)
