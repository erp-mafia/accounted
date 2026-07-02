import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * GET /api/bookkeeping/journal-entries/[id]/retag-log
 *
 * The entry's dimension retag history (dimensions plan PR6) — the immutable
 * before/after trail behind every Tier-2 retag, newest first.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.retag_log',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

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
