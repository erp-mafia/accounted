import { NextResponse } from 'next/server'
import { contentDisposition } from '@/lib/api/content-disposition'
import { OPAQUE_DOCUMENT_CSP, inlineSafeMimeType } from '@/lib/core/documents/storage-proxy'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { withAttestLinkToken } from '@/lib/supplier-invoices/attest-link-route'

const EXTENSION_MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * GET /api/attest/:token/document: the supplier's own invoice document, for
 * the attest page a link opens without a login. Only the document of the
 * invoice the link names; streamed inline the way /api/documents/:id/inline
 * does, under the opaque CSP for anything that is not a PDF or a picture.
 */
export const GET = withAttestLinkToken<{ token: string }>('attest_link.document', async (_request, { link, service, log, requestId }) => {
  const { data: invoice } = await service
    .from('supplier_invoices')
    .select('document_id')
    .eq('company_id', link.company_id)
    .eq('id', link.supplier_invoice_id)
    .maybeSingle()
  const documentId = (invoice as { document_id: string | null } | null)?.document_id
  if (!documentId) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'attest link invoice without a document' })
  const { data: doc } = await service
    .from('document_attachments')
    .select('id, file_name, mime_type, storage_path')
    .eq('company_id', link.company_id)
    .eq('id', documentId)
    .maybeSingle()
  const row = doc as { file_name: string; mime_type: string | null; storage_path: string } | null
  if (!row) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'attest link document missing' })
  const { data: blob, error } = await service.storage.from('documents').download(row.storage_path)
  if (error || !blob) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'attest link document not downloadable' })
  const ext = row.file_name.toLowerCase().split('.').pop() ?? ''
  const contentType =
    row.mime_type && row.mime_type !== 'application/octet-stream' ? row.mime_type : EXTENSION_MIME_MAP[ext] ?? 'application/octet-stream'
  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition('inline', row.file_name),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(inlineSafeMimeType(contentType) ? {} : { 'Content-Security-Policy': OPAQUE_DOCUMENT_CSP }),
    },
  })
})
