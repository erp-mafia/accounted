import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { contentDisposition } from '@/lib/api/content-disposition'
import { withRouteContext } from '@/lib/api/with-route-context'
import { OPAQUE_DOCUMENT_CSP, inlineSafeMimeType } from '@/lib/core/documents/storage-proxy'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/documents/:id/inline
 *
 * Same-origin proxy that streams a document attachment with
 * `Content-Disposition: inline`, allowing it to render inside
 * an <iframe> or <img> tag.
 *
 * Supabase Storage signed URLs return `Content-Disposition: attachment`,
 * which browsers refuse to render inline: that triggers the
 * "Det här innehållet har blockerats" error in journal entry previews.
 *
 * Defense in depth: the user's cookie-bound client authorizes access
 * (RLS + explicit company_id filter) before the service-role client
 * fetches the file from the non-public `documents` bucket.
 *
 * Content types are served on an allow-list basis: only the natively
 * inline-safe types (INLINE_SAFE_MIME_TYPES: PDF and raster images) render
 * with the app origin's authority. Every other resolved type is served
 * under OPAQUE_DOCUMENT_CSP, which keeps it opaque-origin and script-free
 * while still letting the preview render (HTML mail bodies, Peppol XML,
 * iXBRL). The mime_type column was client-declared for legacy rows, so the
 * decision cannot trust it beyond membership in the allow-list.
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
 * that broke Chrome's PDF viewer for older rows: the plugin would load
 * via <object type="application/pdf"> but refuse to parse a response
 * served as octet-stream. Falling back to the file extension covers every
 * legacy row without a DB backfill.
 */
function resolveContentType(fileName: string, dbMimeType: string | null): string {
  if (dbMimeType && dbMimeType !== 'application/octet-stream') return dbMimeType
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  return EXTENSION_MIME_MAP[ext] ?? dbMimeType ?? 'application/octet-stream'
}
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.inline',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Authorize via the auth-bound client and the active tenant. RLS remains
    // the second layer, while the explicit company filter prevents a document
    // from another membership being opened through a guessed identifier.
    const { data: doc, error: docError } = await supabase
      .from('document_attachments')
      .select('id, company_id, file_name, mime_type, storage_path')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (docError || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    // Use the service-role client to read from the non-public bucket only after
    // the active-company authorization check above has succeeded.
    const serviceClient = createServiceClient()
    const { data: blob, error: downloadError } = await serviceClient.storage
      .from('documents')
      .download(doc.storage_path)

    if (downloadError || !blob) {
      return NextResponse.json(
        { error: `Failed to download document: ${getUserErrorMessage(downloadError) ?? 'unknown error'}` },
        { status: 500 },
      )
    }

    const contentType = resolveContentType(doc.file_name, doc.mime_type)

    return new NextResponse(blob, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // RFC 5987 dual form: NFD filenames from macOS/iOS uploads contain
        // combining marks (> 0xFF), which undici Headers reject as non-
        // ByteString values; splicing the raw name here 500ed the route.
        'Content-Disposition': contentDisposition('inline', doc.file_name),
        'Cache-Control': 'private, no-store',
        // Block MIME sniffing: Content-Type is derived from DB metadata
        // (with extension fallback for legacy rows), never from response
        // content. Without nosniff a tampered file_name extension could
        // serve a stored document under an attacker-chosen MIME type.
        'X-Content-Type-Options': 'nosniff',
        // Allow-list, not deny-list: anything that is not a natively
        // inline-safe type (text/html mail bodies, XHTML, XML, SVG, JSON,
        // unknown or legacy types) is uploader-controlled active content
        // when rendered on this origin. The sandboxing policy neutralises
        // scripts and outbound requests for all of them while the preview
        // keeps rendering; see OPAQUE_DOCUMENT_CSP. PDF and raster images
        // are exempt because the directive would also break Chrome's
        // built-in PDF viewer (it renders through an internal <embed>).
        ...(inlineSafeMimeType(contentType)
          ? {}
          : { 'Content-Security-Policy': OPAQUE_DOCUMENT_CSP }),
      },
    })
  },
)
