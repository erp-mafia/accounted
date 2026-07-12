/**
 * POST /api/v1/companies/{companyId}/documents
 *
 * Multipart upload of a document into the WORM archive. Wraps
 * lib/core/documents/document-service.uploadDocument: hashes the bytes
 * (SHA-256), writes to Supabase Storage under documents/{userId}/...,
 * inserts an immutable row into document_attachments (version=1,
 * is_current_version=true).
 *
 * multipart/form-data parts:
 *   file              (required, binary): the document; MIME validated
 *   upload_source     (optional)        : 'file_upload' (default) | 'camera' | 'email' | 'api'
 *   journal_entry_id  (optional UUID)   : link the document to a JE at upload time
 *   journal_entry_line_id (optional UUID): link to a specific JE line
 *
 * Idempotent (mandatory Idempotency-Key: the SHA-256 of the bytes is the
 * deduplication anchor on retry inside the engine's `upsert: false` storage
 * write).
 *
 * Dry-run is NOT supported on this endpoint: the engine hashes + stores +
 * inserts atomically; the "dry-run" equivalent is a client-side
 * size+MIME check before submitting. Future iteration may add a header-only
 * preflight; held back to keep the multipart contract minimal.
 *
 * WORM (BFL 7 kap): once inserted, the row cannot be modified or deleted
 * if it is linked to a posted journal entry: the DB trigger blocks both.
 * Updating a document means uploading a new VERSION via the dashboard
 * (no v1 endpoint today; bypassing through the dashboard is intentional
 * until the contract is hardened with audit-trail tests).
 */

import { z } from 'zod'
import { created } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import {
  uploadDocument,
  validateDocumentFile,
  MAX_DOCUMENT_SIZE,
  ALLOWED_DOCUMENT_TYPES,
} from '@/lib/core/documents/document-service'
import type { DocumentUploadSource } from '@/types'

const DocumentUploaded = z.object({
  id: z.string().uuid(),
  file_name: z.string(),
  mime_type: z.string().nullable(),
  file_size_bytes: z.number(),
  sha256_hash: z.string(),
  version: z.number().int(),
  is_current_version: z.boolean(),
  upload_source: z.string().nullable(),
  journal_entry_id: z.string().uuid().nullable(),
  journal_entry_line_id: z.string().uuid().nullable(),
  created_at: z.string(),
})

// For the registry, the Zod body is a metadata-only shape (everything the
// caller MIGHT supply in the multipart envelope besides the file itself).
// The actual multipart parsing happens in-route via request.formData().
const MultipartBodySchema = z.object({
  file: z.unknown(), // OpenAPI generator renders this as { type: 'string', format: 'binary' }
  upload_source: z.enum(['file_upload', 'camera', 'email', 'api']).optional(),
  journal_entry_id: z.string().uuid().optional(),
  journal_entry_line_id: z.string().uuid().optional(),
})

registerEndpoint({
  operation: 'documents.upload',
  method: 'POST',
  path: '/api/v1/companies/:companyId/documents',
  summary: 'Upload a document to the WORM archive.',
  description: `Multipart upload of a document (PDF / image) under the BFL 7 kap retention regime. The bytes are hashed (SHA-256), written to Supabase Storage, and recorded in document_attachments at version=1. Allowed MIME types: ${ALLOWED_DOCUMENT_TYPES.join(', ')}. Max size: ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB.`,
  useWhen:
    'You have a receipt, invoice scan, or supporting document for a posted verifikation and want it archived for the 7-year BFL retention period. Optionally link to a journal entry at upload time via journal_entry_id.',
  doNotUseFor:
    'Updating an existing document (no v1 update endpoint; new versions go through the dashboard). Bulk uploads: call once per file.',
  pitfalls: [
    'Idempotency-Key is mandatory; multipart retries with the same key replay the cached response.',
    `Max size ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB enforced server-side: DOC_UPLOAD_TOO_LARGE on overrun.`,
    `Only ${ALLOWED_DOCUMENT_TYPES.join(' / ')} accepted: DOC_UPLOAD_UNSUPPORTED_TYPE otherwise.`,
    'WORM: once linked to a posted journal entry, the document row cannot be modified or deleted (DB trigger). Upload-then-link is reversible (the document exists with journal_entry_id=null until linked); once linked, treat as immutable.',
    'Dry-run is not supported on this endpoint: the engine hashes + stores + inserts in one atomic flow.',
  ],
  example: {
    request: {
      // OpenAPI generator renders these as multipart parts.
      file: '<binary>',
      upload_source: 'api',
      journal_entry_id: 'a8f1…',
    },
    response: {
      data: {
        id: '0e9c…',
        file_name: 'kvitto-2026-05-12.pdf',
        mime_type: 'application/pdf',
        file_size_bytes: 184320,
        sha256_hash: '8a7f…',
        version: 1,
        is_current_version: true,
        journal_entry_id: 'a8f1…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'documents:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: MultipartBodySchema, contentType: 'multipart/form-data' },
  response: { success: dataEnvelope(DocumentUploaded) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'documents.upload',
  async (request, ctx) => {
    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'body',
          message:
            'Body must be multipart/form-data with a `file` part. Set Content-Type accordingly.',
        },
      })
    }

    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      return v1ErrorResponseFromCode('DOC_UPLOAD_NO_FILE', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const validationError = validateDocumentFile({ size: file.size, type: file.type })
    if (validationError) {
      // The validator returns a Swedish string. Bucket by error category
      // so the agent receives a stable code.
      const code = /storlek|stor|MB|tom/i.test(validationError)
        ? 'DOC_UPLOAD_TOO_LARGE'
        : 'DOC_UPLOAD_UNSUPPORTED_TYPE'
      return v1ErrorResponseFromCode(code, ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: validationError,
          file_size_bytes: file.size,
          mime_type: file.type,
          max_size_bytes: MAX_DOCUMENT_SIZE,
          allowed_types: ALLOWED_DOCUMENT_TYPES,
        },
      })
    }

    // Optional metadata fields. upload_source is enum-validated at runtime
    // (the column has no CHECK constraint, so an unrecognised value would
    // persist as-is otherwise).
    const uploadSourceRaw = formData.get('upload_source')
    const UploadSourceSchema = z.enum(['file_upload', 'camera', 'email', 'api'])
    let uploadSource: DocumentUploadSource = 'file_upload'
    if (typeof uploadSourceRaw === 'string') {
      const parsed = UploadSourceSchema.safeParse(uploadSourceRaw)
      if (!parsed.success) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            field: 'upload_source',
            message: `upload_source must be one of: ${UploadSourceSchema.options.join(', ')}.`,
            attempted: uploadSourceRaw,
          },
        })
      }
      uploadSource = parsed.data
    }

    const journalEntryIdRaw = formData.get('journal_entry_id')
    const journalEntryId = typeof journalEntryIdRaw === 'string' ? journalEntryIdRaw : undefined
    if (journalEntryId && !z.string().uuid().safeParse(journalEntryId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'journal_entry_id', message: 'must be a UUID' },
      })
    }
    const journalEntryLineIdRaw = formData.get('journal_entry_line_id')
    const journalEntryLineId = typeof journalEntryLineIdRaw === 'string' ? journalEntryLineIdRaw : undefined
    if (journalEntryLineId && !z.string().uuid().safeParse(journalEntryLineId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'journal_entry_line_id', message: 'must be a UUID' },
      })
    }

    // If the caller supplied journal_entry_id, verify it belongs to the
    // caller's company before the upload commits. Otherwise we'd persist a
    // document whose `journal_entry_id` points at another company's JE:
    // the DB has no FK enforcing cross-table tenancy.
    if (journalEntryId) {
      const { data: jeRow, error: jeErr } = await ctx.supabase
        .from('journal_entries')
        .select('id')
        .eq('id', journalEntryId)
        .eq('company_id', ctx.companyId!)
        .maybeSingle()
      if (jeErr) {
        ctx.log.error('documents.upload JE pre-check DB error', jeErr as Error, { journalEntryId })
        return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
          requestId: ctx.requestId, details: { step: 'je_ownership_check' },
        })
      }
      if (!jeRow) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'journal_entry', field: 'journal_entry_id' },
        })
      }
    }

    // If the caller supplied journal_entry_line_id, verify the line belongs
    // to the supplied JE (and transitively to the company we already
    // validated). Without this guard the row would persist with a
    // line-level pointer to another company's JE line.
    if (journalEntryLineId) {
      if (!journalEntryId) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            field: 'journal_entry_line_id',
            message: 'journal_entry_line_id requires journal_entry_id.',
          },
        })
      }
      const { data: lineRow, error: lineErr } = await ctx.supabase
        .from('journal_entry_lines')
        .select('id')
        .eq('id', journalEntryLineId)
        .eq('journal_entry_id', journalEntryId)
        .maybeSingle()
      if (lineErr) {
        ctx.log.error('documents.upload JE-line pre-check DB error', lineErr as Error, { journalEntryLineId })
        return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
          requestId: ctx.requestId, details: { step: 'je_line_ownership_check' },
        })
      }
      if (!lineRow) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'journal_entry_line', field: 'journal_entry_line_id' },
        })
      }
    }

    const opLog = ctx.log.child({ filename: file.name, sizeBytes: file.size })

    try {
      const buffer = await file.arrayBuffer()
      const document = await uploadDocument(
        ctx.supabase,
        ctx.userId,
        ctx.companyId!,
        { name: file.name, buffer, type: file.type },
        {
          upload_source: uploadSource,
          journal_entry_id: journalEntryId,
          journal_entry_line_id: journalEntryLineId,
        },
      )
      // `storage_path` is deliberately omitted from the public response:
      // the path encodes internal layout (userId prefix + timestamp) which
      // /download deliberately keeps hidden. Use /download/{id} to fetch
      // the actual bytes via a short-lived signed URL.
      return created(
        {
          id: document.id,
          file_name: document.file_name,
          mime_type: document.mime_type,
          file_size_bytes: document.file_size_bytes,
          sha256_hash: document.sha256_hash,
          version: document.version,
          is_current_version: document.is_current_version,
          upload_source: document.upload_source,
          journal_entry_id: document.journal_entry_id,
          journal_entry_line_id: document.journal_entry_line_id,
          created_at: document.created_at,
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      // Magic-byte validation rejections (validateDocumentMagicBytes) are a
      // client problem, not a storage failure: surface as 400 with an
      // accurate message instead of the misleading "kunde inte sparas".
      if (/kunde inte verifieras|matchar inte den angivna filtypen/i.test(message)) {
        opLog.warn('document upload rejected by content validation', { reason: message })
        return v1ErrorResponseFromCode('DOC_UPLOAD_INVALID_CONTENT', opLog, {
          requestId: ctx.requestId,
          details: { reason: message },
        })
      }
      // Full error is logged above; the raw message can leak storage-layer
      // internals, so the client only gets the generic code + requestId.
      opLog.error('document upload failed', err as Error)
      return v1ErrorResponseFromCode('DOC_UPLOAD_STORAGE_FAILED', opLog, {
        requestId: ctx.requestId,
      })
    }
  },
  { requireIdempotencyKey: true },
)
