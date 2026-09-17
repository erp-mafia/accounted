import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { ensureDocumentRead } from '@/lib/documents/read/on-demand'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/documents/[id]/text
 * The document as Arkiv read it, page by page, for the reader who wants the
 * whole thing rather than the fields. The same text agents get through
 * gnubok_get_source. Reads on demand what the history lanes left unread.
 * Capped so a 300-page bundle does not become one answer.
 */
export interface DocumentTextView {
  document_id: string
  page_count: number | null
  pages: Array<{ page_no: number; text: string; reader: string }>
  truncated: boolean
}

const MAX_CHARS = 200_000

export const GET = withRouteContext('document.text', async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const { data: doc, error: docError } = await ctx.supabase.from('document_attachments').select('id, page_count').eq('id', id).eq('company_id', ctx.companyId).maybeSingle()
  if (docError) return NextResponse.json({ error: getErrorMessage(docError) }, { status: 500 })
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // A person asking for the text is the question history waited for: read it now if the lanes left it.
  try {
    await ensureDocumentRead(createServiceClient(), ctx.companyId, id)
  } catch (err) {
    ctx.log.warn('on-demand read failed', { doc: id, reason: err instanceof Error ? err.message : String(err) })
  }
  const { data, error } = await ctx.supabase.from('document_pages').select('page_no, text, reader').eq('document_id', id).order('page_no', { ascending: true })
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  const pages: DocumentTextView['pages'] = []
  let used = 0
  let truncated = false
  for (const p of (data ?? []) as DocumentTextView['pages']) {
    if (used + p.text.length > MAX_CHARS) {
      truncated = true
      break
    }
    used += p.text.length
    pages.push(p)
  }
  return NextResponse.json({ data: { document_id: id, page_count: (doc as { page_count: number | null }).page_count, pages, truncated } satisfies DocumentTextView })
})
