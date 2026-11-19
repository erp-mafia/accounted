import { z } from 'zod'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { buildPendingDocumentStoragePath, DOCUMENTS_BUCKET } from '@/lib/core/documents/document-service'

/**
 * The file of a multipart document upload, wherever its bytes travelled.
 *
 * The platform rejects a request body over 4.5 MB before a route runs
 * (lib/documents/upload-size.ts), so the browser sends a larger file straight
 * to Storage first (POST /api/documents/uploads, then a PUT to the signed URL)
 * and the multipart body carries only `upload_id`, `file_name` and
 * `mime_type` in place of `file`. This reads the staged object back and hands
 * the route the same File it would have received inline, so every check after
 * it (size, type, magic bytes, period lock, linking) runs exactly as for a
 * small file. Nothing the browser says about the content is trusted: the
 * route measures and validates the bytes it gets here.
 *
 * The key is rebuilt from the caller's own company and user, so an upload id
 * can only ever reach the caller's own pending prefix. The pending object is
 * removed once read; a route that then refuses the file leaves nothing behind,
 * and an abandoned reservation is swept by the next create.
 */

const StagedUploadSchema = z.object({
  upload_id: z.string().uuid(),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().max(120),
})

export type UploadedFileResult =
  | { ok: true; file: File }
  | { ok: false; code: 'DOC_UPLOAD_NO_FILE' | 'DOCUMENT_UPLOAD_NOT_FOUND' }

export async function readUploadedFile(
  formData: FormData,
  companyId: string,
  userId: string,
): Promise<UploadedFileResult> {
  const inline = formData.get('file')
  if (inline instanceof File) return { ok: true, file: inline }

  const staged = StagedUploadSchema.safeParse({
    upload_id: formData.get('upload_id'),
    file_name: formData.get('file_name'),
    mime_type: formData.get('mime_type') ?? '',
  })
  if (!staged.success) return { ok: false, code: 'DOC_UPLOAD_NO_FILE' }
  const { upload_id: uploadId, file_name: fileName, mime_type: mimeType } = staged.data

  const storage = createServiceClientNoCookies().storage.from(DOCUMENTS_BUCKET)
  const pendingPath = buildPendingDocumentStoragePath(companyId, userId, uploadId, fileName)
  const { data, error } = await storage.download(pendingPath)
  if (error || !data) return { ok: false, code: 'DOCUMENT_UPLOAD_NOT_FOUND' }

  const buffer = await data.arrayBuffer()
  await storage.remove([pendingPath])
  return { ok: true, file: new File([buffer], fileName, { type: mimeType }) }
}
