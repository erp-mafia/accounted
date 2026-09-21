import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/graph
 * What the Arkiv page draws (decision 7 of the plan): the company as the
 * hub, four clusters on a ring (agreements, authorities, counterparties,
 * assets) with their members, the verifikat band, and what waits for a
 * person. Counts are whole; member lists are capped per cluster.
 */
export type ClusterKey = 'avtal' | 'myndighet' | 'motparter' | 'tillgangar'

export interface GraphNode {
  id: string
  label: string
  href: string
  meta: string | null
}

export interface ArkivGraph {
  company: { name: string; document_count: number }
  clusters: Array<{ key: ClusterKey; count: number; nodes: GraphNode[] }>
  verifikat_count: number
  waiting: GraphNode[]
}

const MEMBERS_PER_CLUSTER = 12
const AUTHORITY_TYPES = ['registration.bolagsverket', 'filing.bolagsverket', 'decision.skatteverket']

export const GET = withRouteContext('arkiv.graph', async (_request, ctx) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const company = ctx.companyId
  const [companyRow, documents, verifikat, agreements, authorities, partyLinks, assetLinks, held, unclassified] = await Promise.all([
    ctx.supabase.from('companies').select('name').eq('id', company).maybeSingle(),
    ctx.supabase.from('document_attachments').select('id', { count: 'exact', head: true }).eq('company_id', company).eq('admission_state', 'admitted'),
    ctx.supabase.from('document_attachments').select('id', { count: 'exact', head: true }).eq('company_id', company).not('journal_entry_id', 'is', null),
    ctx.supabase.from('agreements').select('id, title, kind, ends_on', { count: 'exact' }).eq('company_id', company).order('status', { ascending: true }).order('ends_on', { ascending: true, nullsFirst: false }).limit(MEMBERS_PER_CLUSTER),
    ctx.supabase.from('document_attachments').select('id, file_name, doc_type, created_at', { count: 'exact' }).eq('company_id', company).eq('admission_state', 'admitted').in('doc_type', AUTHORITY_TYPES).order('created_at', { ascending: false }).limit(MEMBERS_PER_CLUSTER),
    ctx.supabase.from('document_links').select('party_id', { count: 'exact' }).eq('company_id', company).eq('target_kind', 'party').is('retired_at', null).limit(500),
    ctx.supabase.from('document_links').select('asset_id', { count: 'exact' }).eq('company_id', company).eq('target_kind', 'asset').is('retired_at', null).limit(500),
    ctx.supabase.from('document_attachments').select('id, file_name').eq('company_id', company).eq('admission_state', 'held').order('created_at', { ascending: false }).limit(3),
    ctx.supabase.from('document_classifications').select('document_id').eq('company_id', company).eq('is_current', true).eq('decided_by', 'model').eq('relevance', 'relevant').eq('doc_type', 'other').limit(3),
  ])
  for (const r of [companyRow, documents, verifikat, agreements, authorities, partyLinks, assetLinks, held, unclassified]) {
    if (r.error) return NextResponse.json({ error: getErrorMessage(r.error) }, { status: 500 })
  }

  const partyIds = [...new Set(((partyLinks.data ?? []) as Array<{ party_id: string }>).map((l) => l.party_id))]
  const assetIds = [...new Set(((assetLinks.data ?? []) as Array<{ asset_id: string }>).map((l) => l.asset_id))]
  const [parties, assets, unclassifiedDocs] = await Promise.all([
    partyIds.length ? ctx.supabase.from('parties').select('id, display_name').in('id', partyIds.slice(0, MEMBERS_PER_CLUSTER)) : Promise.resolve({ data: [], error: null }),
    assetIds.length ? ctx.supabase.from('assets').select('id, name').in('id', assetIds.slice(0, MEMBERS_PER_CLUSTER)) : Promise.resolve({ data: [], error: null }),
    unclassified.data?.length ? ctx.supabase.from('document_attachments').select('id, file_name').in('id', (unclassified.data as Array<{ document_id: string }>).map((d) => d.document_id)) : Promise.resolve({ data: [], error: null }),
  ])
  for (const r of [parties, assets, unclassifiedDocs]) if (r.error) return NextResponse.json({ error: getErrorMessage(r.error) }, { status: 500 })

  const graph: ArkivGraph = {
    company: { name: (companyRow.data as { name: string } | null)?.name ?? '', document_count: documents.count ?? 0 },
    clusters: [
      {
        key: 'avtal',
        count: agreements.count ?? 0,
        nodes: ((agreements.data ?? []) as Array<{ id: string; title: string; kind: string; ends_on: string | null }>).map((a) => ({ id: a.id, label: a.title, href: `/arkiv/avtal/${a.id}`, meta: a.ends_on ? `till ${a.ends_on}` : null })),
      },
      {
        key: 'myndighet',
        count: authorities.count ?? 0,
        nodes: ((authorities.data ?? []) as Array<{ id: string; file_name: string; doc_type: string; created_at: string }>).map((d) => ({ id: d.id, label: d.file_name, href: `/arkiv/dokument/${d.id}`, meta: d.doc_type })),
      },
      {
        key: 'motparter',
        count: partyIds.length,
        nodes: ((parties.data ?? []) as Array<{ id: string; display_name: string }>).map((p) => ({ id: p.id, label: p.display_name, href: `/parties/${p.id}`, meta: null })),
      },
      {
        key: 'tillgangar',
        count: assetIds.length,
        nodes: ((assets.data ?? []) as Array<{ id: string; name: string }>).map((a) => ({ id: a.id, label: a.name, href: `/assets`, meta: null })),
      },
    ],
    verifikat_count: verifikat.count ?? 0,
    waiting: [
      ...((held.data ?? []) as Array<{ id: string; file_name: string }>).map((d) => ({ id: d.id, label: d.file_name, href: '/arkiv/granska', meta: 'held' })),
      ...((unclassifiedDocs.data ?? []) as Array<{ id: string; file_name: string }>).map((d) => ({ id: d.id, label: d.file_name, href: '/arkiv/granska#typ', meta: 'unclassified' })),
    ].slice(0, 3),
  }
  return NextResponse.json({ data: graph })
})
