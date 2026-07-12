import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateDocumentMagicBytes } from '@/lib/core/documents/document-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('documents.integrity')

const ParamsSchema = z.object({ id: z.string().uuid() })

/**
 * GET /api/documents/:id/integrity
 *
 * Probes the actual stored bytes against the declared MIME type. Used by the
 * Bilagor modal to surface a clear "this file is corrupt: please re-upload"
 * warning instead of relying on the browser's PDF viewer error UI, which
 * only fires after the user has already tried to view the file.
 *
 * Some legacy MCP uploads landed with non-PDF bytes under
 * `mime_type = 'application/pdf'` because magic-byte validation was added
 * after those rows were written. This endpoint lets the UI detect and steer
 * the user toward replacing them.
 *
 * Response shape is intentionally minimal: { valid: boolean } only. The
 * reason for an invalid result is logged server-side rather than returned
 * to the client to avoid information disclosure (V1.2.5 / GDPR Art 25(2))
 * and to keep this from being a probe surface for storage internals.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  const rawParams = await params
  const parsed = ParamsSchema.safeParse(rawParams)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid document id' }, { status: 400 })
  }
  const { id } = parsed.data

  // Filter to the current version. The integrity check is meaningful only
  // on the live file; superseded versions are archived bytes and should
  // not be re-probed (they're already preserved in the version chain
  // exactly as uploaded).
  const { data: doc, error: docError } = await supabase
    .from('document_attachments')
    .select('id, company_id, mime_type, storage_path')
    .eq('id', id)
    .eq('is_current_version', true)
    .single()

  if (docError || !doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  // Tenant membership: even with the user-scoped supabase client below,
  // we want a clear 404 rather than relying on a storage-layer RLS deny
  // (which can present as a generic error). RLS on document_attachments
  // is the primary control; this is defense in depth.
  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('company_id', doc.company_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  if (!doc.mime_type) {
    return NextResponse.json({ data: { valid: true } })
  }

  // Use the user-scoped supabase client so the storage download is subject
  // to RLS on storage.objects, not just the application-layer membership
  // check above. A logic bug in the membership check would still be
  // arrested at the storage layer.
  const { data: blob, error: downloadError } = await supabase.storage
    .from('documents')
    .download(doc.storage_path)

  if (downloadError || !blob) {
    log.error('storage download failed for integrity check', downloadError as Error, {
      documentId: id,
      companyId: doc.company_id,
    })
    return NextResponse.json({ error: 'Integrity check unavailable' }, { status: 500 })
  }

  // Only the first 16 bytes are needed for magic-byte detection (PDF/PNG
  // use ≤8, WebP needs 12). Trimming here doesn't change bandwidth (the
  // full blob is already downloaded) but it makes the intent explicit and
  // keeps memory churn off the hot path for large PDFs.
  const headerBuffer = await blob.slice(0, 16).arrayBuffer()
  const magicError = validateDocumentMagicBytes(headerBuffer, doc.mime_type)

  if (magicError) {
    log.warn('document failed magic-byte integrity check', {
      documentId: id,
      companyId: doc.company_id,
      reason: magicError,
    })
  }

  return NextResponse.json({ data: { valid: magicError === null } })
}
