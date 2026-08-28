import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { resolveUserLabelsFromProfiles } from '@/lib/reports/behandlingshistorik'

/**
 * GET /api/bookkeeping/journal-entries/[id]/rattelse-log
 *
 * The entry's inline rättelse history (BFL 5 kap 5 § / 9 §): the immutable
 * who/when trail behind every metadata edit and line strike, newest first.
 * Struck lines render with strikethrough in the verifikat detail view from
 * the struck_lines snapshots here. Each row also carries `actor_label`, the
 * actor's profile label, so the page can say who struck a line without the
 * reader opening a log panel; the raw `actor` uuid is kept unchanged.
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

    const rows = (data ?? []) as ({ actor: string | null } & Record<string, unknown>)[]

    // Who: `profiles` RLS is self-only, so the label lookup goes through the
    // service client, scoped to exactly the actor ids that already appear in
    // this company's own log rows (same precedent as behandlingshistorik).
    // Best-effort: a failed lookup leaves the label null, never the response.
    const actorIds = Array.from(new Set(rows.map((r) => r.actor).filter((a): a is string => !!a)))
    let labels = new Map<string, string>()
    if (actorIds.length > 0) {
      try {
        labels = await resolveUserLabelsFromProfiles(createServiceClient(), actorIds)
      } catch {
        labels = new Map()
      }
    }

    return NextResponse.json({
      data: rows.map((row) => ({
        ...row,
        actor_label: row.actor ? (labels.get(row.actor) ?? null) : null,
      })),
    })
  },
)
