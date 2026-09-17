import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { captureArkivEvent } from '@/lib/arkiv/events'
import { documentTitle } from '@/lib/arkiv/documents/title'
import { isSearchKind, searchRecords, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_QUERY_MAX, SEARCH_QUERY_MIN, type SearchItem, type SearchKind } from '@/lib/arkiv/search'
import type { Payload } from '@/lib/documents/extract/fields'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/search?q=&kinds=&limit=: the archive searched for a person
 * (Arkiv phase 9c). The same retrieval the agent tool uses, presented for a
 * page: a document hit is titled the way the table titles it, not by its
 * file name, and every hit has the record to open and, for a page hit, the
 * original file at that page.
 */
export interface ArkivSearchHit {
  record_ref: string
  kind: SearchKind
  title: string
  /** The file name when it says something the title does not (a duplicate upload, a scan). */
  subtitle: string | null
  /** The matching passage for a page hit (matches wrapped in <b>), the kind and counterparty for an agreement, nothing for a fact. */
  snippet: string | null
  page: number | null
  /** The record page. */
  href: string
  /** The original file, opened at the page it was read from. */
  source_href: string | null
}

export interface ArkivSearchView {
  query: string
  hits: ArkivSearchHit[]
  count: number
}

const querySchema = z.object({
  q: z.string().trim().min(SEARCH_QUERY_MIN).max(SEARCH_QUERY_MAX),
  kinds: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).default(SEARCH_LIMIT_DEFAULT),
})

const inlineHref = (documentId: string, page: number | null) => `/api/documents/${documentId}/inline${page ? `#page=${page}` : ''}`

/** Page text is kept as markdown; a passage shown to a person loses the markers and the line breaks, never the <b> marks. */
export const cleanPassage = (text: string): string => text.replace(/[#*_`]+/g, '').replace(/\s+/g, ' ').trim()

export const GET = withRouteContext('arkiv.search', async (request, ctx) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = validateQuery(request, querySchema)
  if (!parsed.success) return parsed.response
  const { q, limit } = parsed.data
  const kinds = parsed.data.kinds ? parsed.data.kinds.split(',').map((k) => k.trim()) : []
  if (!kinds.every(isSearchKind)) return NextResponse.json({ error: 'Okänd typ av post.' }, { status: 400 })

  let items: SearchItem[]
  try {
    items = await searchRecords(ctx.supabase, ctx.companyId, q, { kinds, limit })
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 })
  }

  // A page hit is titled like the table titles it: "Hyresavtal Kvarnen AB", not "IMG_7485.jpg".
  const docIds = [...new Set(items.filter((i) => i.kind === 'document' && i.document_id).map((i) => i.document_id as string))]
  const titleOf = new Map<string, string>()
  const fileNameOf = new Map<string, string>()
  if (docIds.length) {
    const [docs, extractions, agreements] = await Promise.all([
      ctx.supabase.from('document_attachments').select('id, file_name, doc_type').eq('company_id', ctx.companyId).in('id', docIds),
      ctx.supabase.from('document_extractions').select('document_id, payload').in('document_id', docIds).eq('is_current', true),
      ctx.supabase.from('agreements').select('source_document_id, title').eq('company_id', ctx.companyId).in('source_document_id', docIds),
    ])
    for (const r of [docs, extractions, agreements]) if (r.error) return NextResponse.json({ error: getErrorMessage(r.error) }, { status: 500 })
    const payloadByDoc = new Map(((extractions.data ?? []) as Array<{ document_id: string; payload: Payload }>).map((e) => [e.document_id, e.payload]))
    const agreementTitleByDoc = new Map(((agreements.data ?? []) as Array<{ source_document_id: string; title: string }>).map((a) => [a.source_document_id, a.title]))
    for (const d of (docs.data ?? []) as Array<{ id: string; file_name: string; doc_type: string | null }>) {
      titleOf.set(d.id, documentTitle({ docType: d.doc_type, fileName: d.file_name, payload: payloadByDoc.get(d.id) ?? null, agreementTitle: agreementTitleByDoc.get(d.id) ?? null }))
      fileNameOf.set(d.id, d.file_name)
    }
  }

  const hits: ArkivSearchHit[] = items.map((i) => {
    const id = i.record_ref.slice(i.record_ref.indexOf(':') + 1)
    if (i.kind === 'document') {
      const title = titleOf.get(id) ?? i.title
      const fileName = fileNameOf.get(id) ?? i.title
      return {
        record_ref: i.record_ref,
        kind: i.kind,
        title,
        subtitle: title !== fileName && !fileName.startsWith(title) ? fileName : null,
        snippet: i.snippet ? cleanPassage(i.snippet) : null,
        page: i.page,
        href: `/arkiv/dokument/${id}${i.page ? `?page=${i.page}` : ''}`,
        source_href: inlineHref(id, i.page),
      }
    }
    if (i.kind === 'agreement') {
      return { record_ref: i.record_ref, kind: i.kind, title: i.title, subtitle: null, snippet: i.snippet, page: null, href: `/arkiv/avtal/${id}`, source_href: null }
    }
    // A fact has no page of its own: it opens where it was read from, or the company facts when it was typed in.
    return {
      record_ref: i.record_ref,
      kind: i.kind,
      title: i.title,
      subtitle: null,
      snippet: null,
      page: null,
      href: i.document_id ? `/arkiv/dokument/${i.document_id}` : '/arkiv/myndighet',
      source_href: i.document_id ? inlineHref(i.document_id, null) : null,
    }
  })

  captureArkivEvent('arkiv_searched', { companyId: ctx.companyId, userId: ctx.user.id, kinds: kinds.length ? kinds : 'all', query_length: q.length, hits: hits.length })
  const view: ArkivSearchView = { query: q, hits, count: hits.length }
  return NextResponse.json({ data: view })
})
