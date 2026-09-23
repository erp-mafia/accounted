import { HOSTED_MAX_UPLOAD_BYTES, isShrinkableImage } from './upload-size'

/**
 * Re-encode an oversized photo in the browser so it fits the platform's
 * request-body ceiling (see upload-size.ts for why that ceiling exists).
 *
 * Only reached for files that cannot be sent as they are. The archived
 * document is whatever comes back from here, so the goal is a faithful,
 * durably readable reproduction of the receipt (BFL 7 kap: "varaktigt läsbart
 * skick"), not the smallest possible file. 2400px on the long edge keeps the
 * small print on a receipt legible while taking a 12 MP phone photo well under
 * the limit; quality steps down only if that is not enough.
 *
 * Returns the original file untouched when the browser cannot decode it (HEIC
 * outside Safari, a corrupt image) or when re-encoding would not help. The
 * caller then reports the honest size message rather than uploading something
 * that is going to be rejected in transit.
 */

const MAX_EDGE_PX = 2400
const QUALITY_STEPS = [0.85, 0.7, 0.55]

export async function shrinkImageForUpload(
  file: File,
  maxBytes: number = HOSTED_MAX_UPLOAD_BYTES,
): Promise<File> {
  if (file.size <= maxBytes) return file
  if (!isShrinkableImage(file.type)) return file
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close()
      return file
    }
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    for (const quality of QUALITY_STEPS) {
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', quality)
      })
      if (!blob) return file
      if (blob.size <= maxBytes) {
        return new File([blob], jpegName(file.name), {
          type: 'image/jpeg',
          lastModified: file.lastModified,
        })
      }
    }
    return file
  } catch {
    // A decode the browser refuses (HEIC off Safari) is not an error worth
    // surfacing on its own: the size message the caller falls back to is the
    // one the user can act on.
    return file
  }
}

function jpegName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'underlag'
  return `${base}.jpg`
}
