import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * GET /api/bookkeeping/journal-entries/[id]/rattelse-log
 *
 * The entry's inline rättelse history (BFL 5 kap 5 § / 9 §): the immutable
 * who/when trail behind every metadata edit and line strike, newest first.
 * Struck lines render with strikethrough in the verifikat detail view from
 * the struck_lines snapshots here.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.rattelse_log',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Ownership gate: 404 for entries outside the caller's company, so the
    // empty-log response cannot be used to probe entry existence cross-tenant.
    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (entryError) {
      return NextResponse.json({ error: 'Kunde inte hämta rättelsehistorik' }, { status: 500 })
    }
    if (!entry) {
      return NextResponse.json({ error: 'Verifikatet hittades inte' }, { status: 404 })
    }

    const { data, error } = await supabase
      .from('journal_entry_rattelse_log')
      .select('id, rattelse_type, old_description, new_description, old_entry_date, new_entry_date, struck_lines, added_lines, actor, created_at')
      .eq('company_id', companyId)
      .eq('journal_entry_id', id)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: 'Kunde inte hämta rättelsehistorik' }, { status: 500 })
    }

    return NextResponse.json({ data: data ?? [] })
  },
)
