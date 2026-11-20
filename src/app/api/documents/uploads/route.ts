import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createPendingDocumentUpload, validateDocumentFile } from '@/lib/core/documents/document-service'
import { declaredDocumentType } from '@/lib/documents/upload-types'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

// size_bytes is the browser's own report: the route that takes the upload
// re-measures the bytes, so this only refuses the obviously oversized or
// unsupported before a URL is handed out. file_name must be sent identically
// here and to that route: it is part of the reserved storage key.
const CreateUploadSchema = z.object({
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().max(120),
  size_bytes: z.number().int().min(1),
})

/**
 * POST /api/documents/uploads: reserve a direct-to-Storage upload for a
 * document too large for a request body on hosted (lib/documents/upload-size.ts).
 *
 * Answers a short-lived signed Storage URL. The browser PUTs the bytes there,
 * then posts its usual multipart form to the route that takes the file, with
 * `upload_id`, `file_name` and `mime_type` in place of `file`
 * (lib/core/documents/staged-upload.ts). The URL is the raw Storage URL on
 * purpose: the same-origin /api/storage proxy buffers the body inside a
 * function and would hit the same ceiling.
 */
export const POST = withRouteContext(
  'document.upload.reserve',
  async (request, { user, supabase, companyId, log, requestId }) => {
    const parsed = await validateBody(request, CreateUploadSchema)
    if (!parsed.success) return parsed.response
    const { file_name: fileName, mime_type: mimeType, size_bytes: sizeBytes } = parsed.data

    const declaredType = declaredDocumentType({ name: fileName, type: mimeType })
    const validationError = validateDocumentFile({ size: sizeBytes, type: declaredType })
    if (validationError) {
      const code = /storlek|stor|MB/i.test(validationError) ? 'DOC_UPLOAD_TOO_LARGE' : 'DOC_UPLOAD_UNSUPPORTED_TYPE'
      return errorResponseFromCode(code, log, {
        requestId,
        details: { reason: validationError, sizeBytes, mimeType: declaredType },
      })
    }

    try {
      const reservation = await createPendingDocumentUpload(supabase, companyId, user.id, randomUUID(), fileName)
      return NextResponse.json({
        data: {
          upload_id: reservation.uploadId,
          upload_url: reservation.signedUrl,
          expires_at: reservation.expiresAt,
        },
      })
    } catch (err) {
      log.error('document upload reservation failed', err as Error)
      return errorResponseFromCode('DOC_UPLOAD_STORAGE_FAILED', log, { requestId })
    }
  },
  { requireWrite: true },
)
