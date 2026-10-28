import { NextResponse } from 'next/server'
import { declaredDocumentType, uploadDocument, validateDocumentFile } from '@/lib/core/documents/document-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { readUploadedFile } from '@/lib/core/documents/staged-upload'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponse, errorResponseFromCode, isPeriodLockRefusal } from '@/lib/errors/get-structured-error'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DocumentUploadSource } from '@/types'
import { linkBasisColumns } from '@/lib/links/stamp'

/**
 * POST /api/documents: upload a document to the WORM archive.
 *
 * multipart/form-data:
 *   file: the document file, or, for a file sent straight to Storage first
 *     (POST /api/documents/uploads), upload_id + file_name + mime_type
 *   upload_source (optional): 'camera' | 'file_upload' | 'email' | …
 *   journal_entry_id (optional)
 *   journal_entry_line_id (optional)
 *   dedupe_by_content (optional): 'true' returns the archived document when
 *     the same bytes are already there and reached a verifikat or Underlag
 *     (`deduplicated: true`, `duplicate_of`) instead of storing a copy. Sent
 *     by the Arkiv drop, whose upload is free-floating. Ignored when the
 *     upload names a verifikat or a line: the same underlag legitimately sits
 *     on several verifikat as one copy each, and a document another verifikat
 *     holds cannot be linked to this one
 *     (enforce_document_journal_entry_immutability). The verifikat attachment
 *     zone and the supplier invoice form, which upload first and link after,
 *     therefore do not send it.
 */
export const POST = withRouteContext(
  'document.upload',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const uploaded = await readUploadedFile(formData, companyId, user.id)
    if (!uploaded.ok) {
      return errorResponseFromCode(uploaded.code, log, { requestId })
    }
    const file = uploaded.file

    // A HEIC dropped from a Mac arrives with no declared type: the extension says what it is, the bytes are verified below.
    const declaredType = declaredDocumentType({ name: file.name, type: file.type })
    const validationError = validateDocumentFile({ size: file.size, type: declaredType })
    if (validationError) {
      // The validator returns a Swedish string today. Bucket the failure into
      // a size or type code based on its content.
      const code = /storlek|stor|MB/i.test(validationError)
        ? 'DOC_UPLOAD_TOO_LARGE'
        : 'DOC_UPLOAD_UNSUPPORTED_TYPE'
      return errorResponseFromCode(code, log, {
        requestId,
        details: { reason: validationError, sizeBytes: file.size, mimeType: declaredType },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    try {
      // Whitelist the source — arbitrary strings from formData would otherwise
      // land in the upload_source column; unknown values fall back to the
      // default rather than 400ing an otherwise-valid upload.
      const VALID_SOURCES: DocumentUploadSource[] = [
        'camera', 'file_upload', 'email', 'e_invoice', 'scan', 'api', 'system',
      ]
      const rawSource = formData.get('upload_source')
      const uploadSource: DocumentUploadSource =
        typeof rawSource === 'string' && VALID_SOURCES.includes(rawSource as DocumentUploadSource)
          ? (rawSource as DocumentUploadSource)
          : 'file_upload'
      const journalEntryId = formData.get('journal_entry_id') as string | null
      const journalEntryLineId = formData.get('journal_entry_line_id') as string | null
      const dedupeByContent = formData.get('dedupe_by_content') === 'true' && !journalEntryId && !journalEntryLineId

      const buffer = await file.arrayBuffer()
      const upload = (dedupe: boolean) =>
        uploadDocument(supabase, user.id, companyId!, {
          name: file.name,
          buffer,
          type: declaredType,
        }, {
          upload_source: uploadSource,
          journal_entry_id: journalEntryId || undefined,
          journal_entry_line_id: journalEntryLineId || undefined,
          // The person uploaded it onto the verifikat they named.
          linkBasis: linkBasisColumns('user_confirmed'),
          // The response is the stored row and nothing else; extraction is
          // read later through /api/documents/:id/extraction-status, which
          // reports 'running' until the handler stamps the row. Awaiting the
          // subscribers here held every upload for the length of a model call.
          deferUploadedEvent: true,
          ...(dedupe ? { dedupeByContent: true } : {}),
        })

      let document = await upload(dedupeByContent)
      // A hit counts only when the archived copy went somewhere: onto a
      // verifikat, or into Underlag. Arkiv leaves a receipt it typed more than
      // a day after it arrived out of the queue (QUEUE_NEW_WITHIN_MS), so
      // answering with that copy would leave the person's receipt nowhere;
      // it is stored again, as before the dedupe.
      if (document.deduplicated && !(await reachedTheBooks(supabase, companyId!, document))) {
        opLog.info('archived copy never reached a verifikat or Underlag: storing the upload', { documentId: document.id })
        document = await upload(false)
      }

      // A content hit is the archived document itself: the answer says so,
      // and duplicate_of names it (the same id), so a caller never takes it for a new row.
      return NextResponse.json({
        data: document.deduplicated ? { ...document, deduplicated: true, duplicate_of: document.id } : document,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      // DB trigger rejects inserts whose journal_entry_id points at an entry
      // in a closed/locked period. Surface as 400 with the real reason.
      if (isPeriodLockRefusal(err)) {
        return errorResponseFromCode('DOC_UPLOAD_PERIOD_LOCKED', opLog, {
          requestId,
          details: { reason: getErrorMessage(err) },
        })
      }
      // Magic-byte validation rejections (validateDocumentMagicBytes) are a
      // client problem, not a storage failure: surface as 400 with an
      // accurate message instead of the misleading "kunde inte sparas".
      if (/kunde inte verifieras|matchar inte den angivna filtypen/i.test(message)) {
        opLog.warn('document upload rejected by content validation', { reason: message })
        return errorResponseFromCode('DOC_UPLOAD_INVALID_CONTENT', opLog, {
          requestId,
          details: { reason: getErrorMessage(err) },
        })
      }
      // Full error is logged above; the raw message can leak storage-layer
      // internals, so the client only gets the generic code + requestId.
      opLog.error('document upload failed', err as Error)
      return errorResponseFromCode('DOC_UPLOAD_STORAGE_FAILED', opLog, { requestId })
    }
  },
  { requireWrite: true },
)

/**
 * Whether an archived document went anywhere a person works it: a verifikat
 * holds it, or an inbox item carries it. A failed lookup answers false, which
 * stores the upload as the route did before the dedupe.
 */
async function reachedTheBooks(
  supabase: SupabaseClient,
  companyId: string,
  document: { id: string; journal_entry_id: string | null },
): Promise<boolean> {
  if (document.journal_entry_id) return true
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('company_id', companyId)
    .eq('document_id', document.id)
    .limit(1)
  if (error) return false
  return ((data as unknown[] | null) ?? []).length > 0
}

/**
 * GET /api/documents: list documents.
 *
 * Query params:
 *   journal_entry_id: filter by JE
 *   current_only:     'false' to include older versions (default true)
 *   limit, offset
 */
export const GET = withRouteContext(
  'document.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const journalEntryId = searchParams.get('journal_entry_id')
    const currentOnly = searchParams.get('current_only') !== 'false'
    // Clamp pagination — parseInt('abc') is NaN and unbounded limits let a
    // caller demand the whole table in one page.
    const rawLimit = parseInt(searchParams.get('limit') || '50', 10)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 50
    const rawOffset = parseInt(searchParams.get('offset') || '0', 10)
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

    let query = supabase
      .from('document_attachments')
      .select('*', { count: 'exact' })
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (journalEntryId) query = query.eq('journal_entry_id', journalEntryId)
    if (currentOnly) query = query.eq('is_current_version', true)

    const { data, error, count } = await query

    if (error) {
      log.error('document list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data, count })
  },
)
