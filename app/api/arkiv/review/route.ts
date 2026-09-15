import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/review
 * The review queues of Arkiv for the active company: documents held at the
 * door ("rör det här bolaget?"), admitted documents whose type the model
 * could not settle, and records with fields a person must confirm (phase 3:
 * the two readings disagreed or a check failed). 404 outside the rollout.
 */
export interface ReviewDocument {
  document_id: string
  file_name: string
  created_at: string
  page_count: number | null
  doc_type: string | null
  confidence: number | null
  relevance: string | null
  relevance_reason: string | null
  addressed_to: string | null
  summary: string | null
  suggested_type: string | null
}

export interface FieldReviewDocument {
  document_id: string
  file_name: string
  created_at: string
  doc_type: string | null
  schema_type: string
  review_fields: string[]
}

export const GET = withRouteContext('arkiv.review', async (_request, ctx) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: held, error: heldError } = await ctx.supabase
    .from('document_attachments')
    .select('id, file_name, created_at, page_count, doc_type')
    .eq('company_id', ctx.companyId)
    .eq('admission_state', 'held')
    .order('created_at', { ascending: false })
    .limit(100)
  if (heldError) return NextResponse.json({ error: getErrorMessage(heldError) }, { status: 500 })

  const { data: unsure, error: unsureError } = await ctx.supabase
    .from('document_classifications')
    .select('document_id, doc_type, confidence, relevance, relevance_reason, addressed_to, summary, suggested_type')
    .eq('company_id', ctx.companyId)
    .eq('is_current', true)
    .eq('decided_by', 'model')
    .or('relevance.neq.relevant,doc_type.eq.other,confidence.lt.0.6')
    .limit(200)
  if (unsureError) return NextResponse.json({ error: getErrorMessage(unsureError) }, { status: 500 })

  const byDoc = new Map<string, Record<string, unknown>>()
  for (const c of (unsure ?? []) as Array<Record<string, unknown>>) byDoc.set(c.document_id as string, c)

  const heldRows = ((held ?? []) as Array<Record<string, unknown>>).map((d) => toReview(d, byDoc.get(d.id as string)))
  const heldIds = new Set(heldRows.map((r) => r.document_id))
  const unsureIds = [...byDoc.keys()].filter((id) => !heldIds.has(id))
  let unclassifiedRows: ReviewDocument[] = []
  if (unsureIds.length) {
    const { data: docs, error: docsError } = await ctx.supabase
      .from('document_attachments')
      .select('id, file_name, created_at, page_count, doc_type')
      .eq('company_id', ctx.companyId)
      .eq('admission_state', 'admitted')
      .in('id', unsureIds)
      .order('created_at', { ascending: false })
    if (docsError) return NextResponse.json({ error: getErrorMessage(docsError) }, { status: 500 })
    unclassifiedRows = ((docs ?? []) as Array<Record<string, unknown>>)
      .map((d) => toReview(d, byDoc.get(d.id as string)))
      .filter((r) => r.relevance === 'relevant')
  }
  const { data: pending, error: pendingError } = await ctx.supabase
    .from('document_extractions')
    .select('document_id, schema_type, review_fields')
    .eq('company_id', ctx.companyId)
    .eq('is_current', true)
    .not('review_fields', 'eq', '{}')
    .limit(200)
  if (pendingError) return NextResponse.json({ error: getErrorMessage(pendingError) }, { status: 500 })
  let fieldRows: FieldReviewDocument[] = []
  const pendingList = (pending ?? []) as Array<{ document_id: string; schema_type: string; review_fields: string[] }>
  if (pendingList.length) {
    const { data: docs, error: docsError } = await ctx.supabase
      .from('document_attachments')
      .select('id, file_name, created_at, doc_type')
      .eq('company_id', ctx.companyId)
      .in('id', pendingList.map((p) => p.document_id))
      .order('created_at', { ascending: false })
    if (docsError) return NextResponse.json({ error: getErrorMessage(docsError) }, { status: 500 })
    const byId = new Map(pendingList.map((p) => [p.document_id, p]))
    fieldRows = ((docs ?? []) as Array<{ id: string; file_name: string; created_at: string; doc_type: string | null }>).map((d) => ({
      document_id: d.id,
      file_name: d.file_name,
      created_at: d.created_at,
      doc_type: d.doc_type,
      schema_type: byId.get(d.id)?.schema_type ?? 'generic',
      review_fields: byId.get(d.id)?.review_fields ?? [],
    }))
  }
  return NextResponse.json({ data: { held: heldRows, unclassified: unclassifiedRows, fields: fieldRows } })
})

function toReview(d: Record<string, unknown>, c: Record<string, unknown> | undefined): ReviewDocument {
  return {
    document_id: d.id as string,
    file_name: d.file_name as string,
    created_at: d.created_at as string,
    page_count: (d.page_count as number | null) ?? null,
    doc_type: (c?.doc_type as string | undefined) ?? (d.doc_type as string | null) ?? null,
    confidence: (c?.confidence as number | undefined) ?? null,
    relevance: (c?.relevance as string | undefined) ?? null,
    relevance_reason: (c?.relevance_reason as string | undefined) ?? null,
    addressed_to: (c?.addressed_to as string | undefined) ?? null,
    summary: (c?.summary as string | undefined) ?? null,
    suggested_type: (c?.suggested_type as string | undefined) ?? null,
  }
}
