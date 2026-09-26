import type { SupabaseClient } from '@supabase/supabase-js'
import { HEIC_MIME_TYPES, IMAGE_MAX_DIMENSION, decodeHeicToJpeg } from '@/lib/documents/read/image'
import { createLogger } from '@/lib/logger'

const log = createLogger('documents/preview')

/**
 * What the inline viewer shows for a photo (2026-09-26). An iPhone HEIC was
 * decoded on every view (5.5 s, no cache) and sent at full resolution
 * (3.4 MB), and ordinary photos went out at up to 5 MB, so opening a receipt
 * in Dokument was slow. The viewer now gets a JPEG of at most
 * IMAGE_MAX_DIMENSION on the long edge, made once per document and kept in
 * the documents bucket under previews/, a prefix no member policy reaches
 * (members read documents/{companyId}/...); only the service role writes and
 * reads it. The original file is never touched: "open in a new tab" still
 * serves it.
 */
export const PREVIEW_VERSION = 'v1'
/** A JPEG, PNG or WebP this small is served as it is: resizing would save little. */
export const PREVIEW_MIN_BYTES = 1_000_000
const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp'])

export const previewPath = (companyId: string, documentId: string): string => `previews/${companyId}/${documentId}-${PREVIEW_VERSION}.jpg`

const isHeic = (mime: string): boolean => (HEIC_MIME_TYPES as readonly string[]).includes(mime)

/** Whether the viewer gets a preview instead of the file: every HEIC, and a photo large enough to be worth shrinking. */
export function needsPreview(mime: string, sizeBytes: number | null | undefined): boolean {
  if (isHeic(mime)) return true
  // A row without a recorded size is served as it is, as before.
  return RESIZABLE.has(mime) && sizeBytes != null && sizeBytes > PREVIEW_MIN_BYTES
}

/** A JPEG no larger than IMAGE_MAX_DIMENSION on the long edge, turned upright from its EXIF orientation. */
export async function makePreview(bytes: Buffer, mime: string): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  // The prebuilt sharp has no HEVC decoder: a HEIC goes through heic-convert first.
  const input = isHeic(mime) ? await decodeHeicToJpeg(bytes) : bytes
  return sharp(input)
    .rotate()
    .resize({ width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer()
}

export interface PreviewDocument {
  id: string
  company_id: string
  mime: string
  storage_path: string
}

/**
 * The preview for a document: the kept one when it exists, otherwise made
 * from the original (given, or downloaded) and kept for next time. Null when
 * it cannot be made; the caller then serves the original. Never throws.
 */
export async function ensurePreview(service: SupabaseClient, doc: PreviewDocument, original?: Buffer): Promise<Buffer | null> {
  const path = previewPath(doc.company_id, doc.id)
  // A client without storage (a test double, a stripped-down deployment) gets no preview, not an error.
  if (!service.storage) return null
  const bucket = service.storage.from('documents')
  try {
    const kept = await bucket.download(path)
    if (kept.data && !kept.error) return Buffer.from(await kept.data.arrayBuffer())
  } catch {
    // Not kept yet (or storage hiccup): make it.
  }
  try {
    let bytes = original
    if (!bytes) {
      const { data, error } = await bucket.download(doc.storage_path)
      if (error || !data) return null
      bytes = Buffer.from(await data.arrayBuffer())
    }
    const preview = await makePreview(bytes, doc.mime)
    const { error: uploadError } = await bucket.upload(path, preview, { contentType: 'image/jpeg', upsert: true })
    if (uploadError) log.warn('preview not kept', { documentId: doc.id, reason: uploadError.message })
    return preview
  } catch (err) {
    log.warn('preview not made', { documentId: doc.id, reason: err instanceof Error ? err.message : String(err) })
    return null
  }
}
