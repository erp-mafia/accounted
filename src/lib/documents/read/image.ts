import { createLogger } from '@/lib/logger'
import type { AiImageMediaType } from '@/lib/ai'

const log = createLogger('documents/read/image')

/**
 * The model refuses an image above 5 MB as sent, and a 12 MP phone photo is
 * routinely 3 to 5 MB, so a receipt photographed on a phone came back
 * "image exceeds 5 MB maximum" (seen 2026-09-22, two 4.2 MB Skatteverket
 * photos). The inbox extension solved the same thing for underlag: rotate by
 * EXIF, fit inside 2000 px, JPEG 80. Same numbers here so a photo reads the
 * same whichever door it came through. HEIC/HEIF (the iPhone default) is
 * transcoded when the local libvips can decode it; prebuilt binaries usually
 * cannot, and then the photo stays as it was and the caller reports it.
 */
// The 5 MB limit is on the base64 the API receives, which is 4/3 of the file: a
// 4.13 MB photo was refused as "5506368 bytes > 5242880". 3.5 MB leaves room.
export const IMAGE_DOWNSCALE_THRESHOLD_BYTES = Math.floor(3.5 * 1024 * 1024)
/**
 * The model also refuses an image with a side over 8000 px, however small the
 * file ("At least one of the image dimensions exceed max allowed size: 8000
 * pixels"). A long receipt strip or a full-page screenshot passes the byte
 * threshold, so it was sent as it was and the reading was lost. Such an image
 * gets the same fit as a large file. The model shrinks every image to its own
 * long-edge limit before reading it, so a strip that long loses detail
 * whatever is sent: it is shrunk, not split.
 */
export const IMAGE_DOWNSCALE_THRESHOLD_PX = 8000
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

/**
 * Whether a side of the image is over the model's limit. Read from the header,
 * so nothing is decoded, which is also why sharp's pixel limit is off here: a
 * header that big still says how big the image is. A header sharp cannot read
 * counts as no, and the image goes out as it was, as before.
 */
async function hasSideOverModelLimit(bytes: Buffer): Promise<boolean> {
  try {
    const sharp = (await import('sharp')).default
    const { width = 0, height = 0 } = await sharp(bytes, { limitInputPixels: false }).metadata()
    return Math.max(width, height) > IMAGE_DOWNSCALE_THRESHOLD_PX
  } catch {
    // Safe to ignore: the image goes out as it was, as before, and a refusal by
    // the model is stamped on the document as its read error.
    return false
  }
}

export async function fitImageForModel(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mediaType: AiImageMediaType } | null> {
  const isHeic = (HEIC_MIME_TYPES as readonly string[]).includes(mimeType)
  const small = bytes.length <= IMAGE_DOWNSCALE_THRESHOLD_BYTES
  const sideOverLimit = !isHeic && small && (await hasSideOverModelLimit(bytes))
  if (!isHeic && small && !sideOverLimit) return { bytes, mediaType: mimeType as AiImageMediaType }
  try {
    // Lazy: sharp is a native module that only images need.
    const sharp = (await import('sharp')).default
    const fit = (input: Buffer) =>
      sharp(input)
        .rotate()
        .resize({ width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
        // JPEG has no alpha: a transparent background turned black, and dark text on it vanished.
        .flatten({ background: '#ffffff' })
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
    // A HEIC nothing could decode has no readable form. An image with a side over the model's
    // limit is refused as it is, so it is not sent either; any other oversized file is still worth the attempt.
    if (isHeic || sideOverLimit || (await hasSideOverModelLimit(bytes))) return null
    return { bytes, mediaType: mimeType as AiImageMediaType }
  }
}
