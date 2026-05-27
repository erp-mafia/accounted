import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { uploadDocument, validateDocumentFile } from '@/lib/core/documents/document-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { DocumentUploadSource } from '@/types'

ensureInitialized()

/**
 * POST /api/documents — upload a document to the WORM archive.
 *
 * multipart/form-data:
 *   file: the document file
 *   upload_source (optional): 'camera' | 'file_upload' | 'email' | …
 *   journal_entry_id (optional)
 *   journal_entry_line_id (optional)
 */
export const POST = withRouteContext(
  'document.upload',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return errorResponseFromCode('DOC_UPLOAD_NO_FILE', log, { requestId })
    }

    const validationError = validateDocumentFile({ size: file.size, type: file.type })
    if (validationError) {
      // The validator returns a Swedish string today. Bucket the failure into
      // a size or type code based on its content.
      const code = /storlek|stor|MB/i.test(validationError)
        ? 'DOC_UPLOAD_TOO_LARGE'
        : 'DOC_UPLOAD_UNSUPPORTED_TYPE'
      return errorResponseFromCode(code, log, {
        requestId,
        details: { reason: validationError, sizeBytes: file.size, mimeType: file.type },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    try {
      const uploadSource = (formData.get('upload_source') as string) || 'file_upload'
      const journalEntryId = formData.get('journal_entry_id') as string | null
      const journalEntryLineId = formData.get('journal_entry_line_id') as string | null

      const buffer = await file.arrayBuffer()

      const document = await uploadDocument(supabase, user.id, companyId!, {
        name: file.name,
        buffer,
        type: file.type,
      }, {
        upload_source: uploadSource as DocumentUploadSource,
        journal_entry_id: journalEntryId || undefined,
        journal_entry_line_id: journalEntryLineId || undefined,
      })

      return NextResponse.json({ data: document })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      // DB trigger rejects inserts whose journal_entry_id points at an entry
      // in a closed/locked period. Surface as 400 with the real reason.
      if (/locked\/closed fiscal period|Bokföringen är låst/i.test(message)) {
        return errorResponseFromCode('DOC_UPLOAD_PERIOD_LOCKED', opLog, {
          requestId,
          details: { reason: message },
        })
      }
      opLog.error('document upload failed', err as Error)
      return errorResponseFromCode('DOC_UPLOAD_STORAGE_FAILED', opLog, {
        requestId,
        details: { reason: message },
      })
    }
  },
  { requireWrite: true },
)

/**
 * GET /api/documents — list documents.
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
    const limit = parseInt(searchParams.get('limit') || '50')
    const offset = parseInt(searchParams.get('offset') || '0')

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
