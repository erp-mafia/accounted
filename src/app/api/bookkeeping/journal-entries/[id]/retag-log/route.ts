import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isUuid } from '@/lib/invariants/uuid'

/**
 * GET /api/bookkeeping/journal-entries/[id]/retag-log
 *
 * The entry's dimension retag history (dimensions plan PR6), the immutable
 * before/after trail behind every Tier-2 retag, newest first.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.retag_log',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    // An id that is not a uuid names no verifikat: 404 before the query,
    // which Postgres refused with a uuid parse error (answered as a 500).
    if (!isUuid(id)) return errorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', log, { requestId })

    const { data, error } = await supabase
      .from('dimension_retag_log')
      .select('id, line_id, old_dimensions, new_dimensions, actor, reason, created_at')
      .eq('company_id', companyId)
      .eq('journal_entry_id', id)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: 'Kunde inte hämta ändringshistorik' }, { status: 500 })
    }

    return NextResponse.json({ data: data ?? [] })
  },
)
