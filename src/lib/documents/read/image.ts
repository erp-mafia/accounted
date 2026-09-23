import { createLogger } from '@/lib/logger'
import type { AiImageMediaType } from '@/lib/ai'

const log = createLogger('documents/read/image')

/**
 * The model refuses an image above 5 MB as sent, and a 12 MP phone photo is
 * routinely 3 to 5 MB, so a receipt photographed on a phone came back
 * "image exceeds 5 MB maximum" (prod 2026-09-22, two 4.2 MB Skatteverket
 * photos). The inbox extension solved the same thing for underlag: rotate by
 * EXIF, fit inside 2000 px, JPEG 80. Same numbers here so a photo reads the
 * same whichever door it came through. HEIC/HEIF (the iPhone default) is
 * transcoded when the local libvips can decode it; prebuilt binaries usually
 * cannot, and then the photo stays as it was and the caller reports it.
 */
// The 5 MB limit is on the base64 the API receives, which is 4/3 of the file: a
// 4.13 MB photo was refused as "5506368 bytes > 5242880". 3.5 MB leaves room.
export const IMAGE_DOWNSCALE_THRESHOLD_BYTES = Math.floor(3.5 * 1024 * 1024)
export const IMAGE_MAX_DIMENSION = 2000

export const HEIC_MIME_TYPES = ['image/heic', 'image/heif'] as const

/**
 * HEIC/HEIF (the iPhone default) decoded to JPEG with heic-convert (libheif
 * as WebAssembly, so it runs wherever Node runs), since the prebuilt sharp
 * has no HEVC decoder. Lazy: the decoder is a few megabytes of WebAssembly
 * that only a phone photo needs.
 */
export async function decodeHeicToJpeg(bytes: Buffer): Promise<Buffer> {
  const convert = (await import('heic-convert')).default
  const out = await convert({ buffer: bytes, format: 'JPEG', quality: 0.9 })
  return Buffer.from(out)
}

export async function fitImageForModel(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mediaType: AiImageMediaType } | null> {
  const isHeic = (HEIC_MIME_TYPES as readonly string[]).includes(mimeType)
  if (!isHeic && bytes.length <= IMAGE_DOWNSCALE_THRESHOLD_BYTES) return { bytes, mediaType: mimeType as AiImageMediaType }
  try {
    // Lazy: sharp is a native module and only oversized photos need it.
    const sharp = (await import('sharp')).default
    const fit = (input: Buffer) =>
      sharp(input)
        .rotate()
        .resize({ width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
    let converted: Buffer
    try {
      converted = await fit(bytes)
    } catch (err) {
      // sharp reads HEIC only when its libvips was built with a decoder; the prebuilt one was not.
      if (!isHeic) throw err
      converted = await fit(await decodeHeicToJpeg(bytes))
    }
    return { bytes: converted, mediaType: 'image/jpeg' }
  } catch (err) {
    log.warn('image not fitted for the model', { mime: mimeType, bytes: bytes.length, reason: err instanceof Error ? err.message : String(err) })
    // A HEIC nothing could decode has no readable form; an oversized JPEG is still worth the attempt.
    return isHeic ? null : { bytes, mediaType: mimeType as AiImageMediaType }
  }
}
