import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import type { FactRow } from '@/lib/arkiv/facts/store'
import { predicateDef } from '@/lib/arkiv/facts/predicates'
import type { Payload } from '@/lib/documents/extract/fields'
import { schemaForType } from '@/lib/documents/extract/schemas'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/documents/[id]
 * One document as a record page needs it: what it is, every extracted field
 * with its page and quote, the facts it established (with history), what it
 * is tied to, and the agreement it made, if any.
 */
export interface DocumentRecordView {
  document_id: string
  file_name: string
  created_at: string
  page_count: number | null
  doc_type: string | null
  admission_state: string
  journal_entry: { id: string; voucher: string } | null
  classification: { summary: string | null; confidence: number | null; decided_by: string; signals: string[] } | null
  record: { extraction_id: string; schema_type: string; pass: string; review_fields: string[]; fields: Array<{ field: string; label: string; value: unknown; page: number | null; quote: string | null; confidence: number; under_review: boolean }> } | null
  facts: Array<{ fact_id: string; predicate: string; label: string; value_text: string; valid_from: string | null; sys_from: string; source_kind: string; superseded_by: boolean }>
  links: Array<{ link_id: string; target_kind: string; target_id: string; basis: string; method: string; label: string | null; href: string | null }>
  agreement: { id: string; title: string } | null
}

export const GET = withRouteContext('arkiv.document', async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const { data: doc, error } = await ctx.supabase.from('document_attachments').select('id, file_name, created_at, page_count, doc_type, admission_state, journal_entry_id').eq('id', id).eq('company_id', ctx.companyId).maybeSingle()
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const d = doc as { id: string; file_name: string; created_at: string; page_count: number | null; doc_type: string | null; admission_state: string; journal_entry_id: string | null }

  const [classification, extraction, facts, links, agreement, entry] = await Promise.all([
    ctx.supabase.from('document_classifications').select('summary, confidence, decided_by, signals').eq('document_id', id).eq('is_current', true).maybeSingle(),
    ctx.supabase.from('document_extractions').select('id, schema_type, pass, payload, review_fields').eq('document_id', id).eq('is_current', true).maybeSingle(),
    ctx.supabase.from('company_facts').select('id, company_id, subject_kind, subject_id, predicate, value, value_text, single_valued, valid_from, valid_to, sys_from, sys_to, rank, deprecation_reason, supersedes_id, status, source_kind, source_document_id, source_extraction_id, sources, confidence, rationale, approved_by_user_id, created_at').eq('company_id', ctx.companyId).eq('source_document_id', id).neq('rank', 'deprecated').order('sys_from', { ascending: false }).limit(200),
    ctx.supabase.from('document_links').select('id, target_kind, target_id, party_id, agreement_id, asset_id, basis, method').eq('document_id', id).is('retired_at', null),
    ctx.supabase.from('agreements').select('id, title').eq('source_document_id', id).maybeSingle(),
    d.journal_entry_id ? ctx.supabase.from('journal_entries').select('id, voucher_series, voucher_number').eq('id', d.journal_entry_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ])
  for (const r of [classification, extraction, facts, links, agreement, entry]) if (r.error) return NextResponse.json({ error: getErrorMessage(r.error) }, { status: 500 })

  const ext = extraction.data as { id: string; schema_type: string; pass: string; payload: Payload; review_fields: string[] } | null
  const labels = new Map(schemaForType(ext?.schema_type).fields.map((f) => [f.name, f.name]))
  const linkRows = (links.data ?? []) as Array<{ id: string; target_kind: string; target_id: string; party_id: string | null; agreement_id: string | null; asset_id: string | null; basis: string; method: string }>
  const partyIds = linkRows.filter((l) => l.party_id).map((l) => l.party_id as string)
  const parties = partyIds.length ? await ctx.supabase.from('parties').select('id, display_name').in('id', partyIds) : { data: [], error: null }
  if (parties.error) return NextResponse.json({ error: getErrorMessage(parties.error) }, { status: 500 })
  const partyName = new Map(((parties.data ?? []) as Array<{ id: string; display_name: string }>).map((p) => [p.id, p.display_name]))
  const factRows = (facts.data ?? []) as FactRow[]
  const e = entry.data as { id: string; voucher_series: string | null; voucher_number: number | null } | null

  const view: DocumentRecordView = {
    document_id: d.id,
    file_name: d.file_name,
    created_at: d.created_at,
    page_count: d.page_count,
    doc_type: d.doc_type,
    admission_state: d.admission_state,
    journal_entry: e ? { id: e.id, voucher: `${e.voucher_series ?? ''}${e.voucher_number ?? ''}` } : null,
    classification: classification.data ? (classification.data as DocumentRecordView['classification']) : null,
    record: ext
      ? {
          extraction_id: ext.id,
          schema_type: ext.schema_type,
          pass: ext.pass,
          review_fields: ext.review_fields,
          fields: Object.entries(ext.payload).map(([name, f]) => ({ field: name, label: labels.get(name) ?? name, value: f.normalized ?? f.value ?? null, page: f.page, quote: f.quote, confidence: f.confidence, under_review: ext.review_fields.includes(name) })),
        }
      : null,
    facts: factRows.map((f) => ({ fact_id: f.id, predicate: f.predicate, label: predicateDef(f.predicate)?.label ?? f.predicate, value_text: f.value_text, valid_from: f.valid_from, sys_from: f.sys_from, source_kind: f.source_kind, superseded_by: f.sys_to != null })),
    links: linkRows.map((l) => ({
      link_id: l.id,
      target_kind: l.target_kind,
      target_id: l.target_id,
      basis: l.basis,
      method: l.method,
      label: l.party_id ? (partyName.get(l.party_id) ?? null) : l.agreement_id ? ((agreement.data as { title: string } | null)?.title ?? null) : null,
      href: l.party_id ? `/parties/${l.party_id}` : l.agreement_id ? `/arkiv/avtal/${l.agreement_id}` : l.asset_id ? '/assets' : null,
    })),
    agreement: (agreement.data as { id: string; title: string } | null) ?? null,
  }
  return NextResponse.json({ data: view })
})
