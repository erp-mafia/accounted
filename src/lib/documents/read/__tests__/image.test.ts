import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { receiptImage } from '@/tests/fixtures/receipt-images'
import { decodeHeicToJpeg, fitImageForModel, IMAGE_DOWNSCALE_THRESHOLD_BYTES, IMAGE_MAX_DIMENSION } from '../image'

// Real sharp: the point is that a phone photo comes out under the model's limit.
describe('fitImageForModel', () => {
  it('leaves a small image as it is', async () => {
    const small = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } }).jpeg().toBuffer()
    const out = await fitImageForModel(small, 'image/jpeg')
    expect(out).toEqual({ bytes: small, mediaType: 'image/jpeg' })
  })

  it('shrinks an oversized photo to fit inside 2000 px as a JPEG', async () => {
    // Noise does not compress: a 4000 x 3000 PNG of it is well over the threshold, like a 12 MP photo.
    const noise = Buffer.alloc(4000 * 3000 * 3)
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24
    const big = await sharp(noise, { raw: { width: 4000, height: 3000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
    expect(big.length).toBeGreaterThan(IMAGE_DOWNSCALE_THRESHOLD_BYTES)
    const out = await fitImageForModel(big, 'image/png')
    expect(out?.mediaType).toBe('image/jpeg')
    const meta = await sharp(out!.bytes).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(IMAGE_MAX_DIMENSION)
    expect(out!.bytes.length).toBeLessThan(5 * 1024 * 1024 * 0.75)
  }, 30_000)

  it('decodes a HEIC phone photo to JPEG when sharp cannot', async () => {
    const heic = Buffer.from(receiptImage('heic'))
    const jpeg = await decodeHeicToJpeg(heic)
    expect(await sharp(jpeg).metadata()).toMatchObject({ format: 'jpeg', width: 64, height: 64 })
    const out = await fitImageForModel(heic, 'image/heic')
    expect(out?.mediaType).toBe('image/jpeg')
    expect((await sharp(out!.bytes).metadata()).format).toBe('jpeg')
  }, 30_000)

  it('gives up on bytes that are not an image the build can decode', async () => {
    expect(await fitImageForModel(Buffer.alloc(IMAGE_DOWNSCALE_THRESHOLD_BYTES + 1, 7), 'image/heic')).toBeNull()
    const out = await fitImageForModel(Buffer.alloc(IMAGE_DOWNSCALE_THRESHOLD_BYTES + 1, 7), 'image/jpeg')
    expect(out?.mediaType).toBe('image/jpeg')
    expect(out?.bytes.length).toBe(IMAGE_DOWNSCALE_THRESHOLD_BYTES + 1)
  })
})
