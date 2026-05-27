import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * GET /api/documents/:id/inline
 *
 * Same-origin proxy that streams a document attachment with
 * `Content-Disposition: inline`, allowing it to render inside
 * an <iframe> or <img> tag.
 *
 * Supabase Storage signed URLs return `Content-Disposition: attachment`,
 * which browsers refuse to render inline — that triggers the
 * "Det här innehållet har blockerats" error in journal entry previews.
 *
 * Defense in depth: the user's cookie-bound client authorizes access
 * (RLS + explicit company_id filter) before the service-role client
 * fetches the file from the non-public `documents` bucket.
 */

const EXTENSION_MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * Resolve the response Content-Type. Some legacy uploads landed with
 * `mime_type = null` or `application/octet-stream` (browsers sometimes
 * report empty File.type for files dragged from certain sources). Combined
 * with the new `X-Content-Type-Options: nosniff` header on this route,
 * that broke Chrome's PDF viewer for older rows — the plugin would load
 * via <object type="application/pdf"> but refuse to parse a response
 * served as octet-stream. Falling back to the file extension covers every
 * legacy row without a DB backfill.
 */
function resolveContentType(fileName: string, dbMimeType: string | null): string {
  if (dbMimeType && dbMimeType !== 'application/octet-stream') return dbMimeType
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  return EXTENSION_MIME_MAP[ext] ?? dbMimeType ?? 'application/octet-stream'
}
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  const { id } = await params

  // Authorize via the auth-bound client: RLS + explicit company filter
  // through user_company_ids (defense in depth).
  const { data: doc, error: docError } = await supabase
    .from('document_attachments')
    .select('id, company_id, file_name, mime_type, storage_path')
    .eq('id', id)
    .single()

  if (docError || !doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  // Explicit membership check on top of RLS.
  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('company_id', doc.company_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  // Use the service-role client to read from the non-public bucket.
  const serviceClient = createServiceClient()
  const { data: blob, error: downloadError } = await serviceClient.storage
    .from('documents')
    .download(doc.storage_path)

  if (downloadError || !blob) {
    return NextResponse.json(
      { error: `Failed to download document: ${downloadError?.message ?? 'unknown error'}` },
      { status: 500 }
    )
  }

  const safeFileName = doc.file_name.replace(/[\r\n"]/g, '_')

  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': resolveContentType(doc.file_name, doc.mime_type),
      'Content-Disposition': `inline; filename="${safeFileName}"`,
      'Cache-Control': 'private, max-age=300',
      // Block MIME sniffing — Content-Type is derived from DB metadata
      // (with extension fallback for legacy rows), never from response
      // content. Without nosniff a tampered file_name extension could
      // serve a stored document under an attacker-chosen MIME type.
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
