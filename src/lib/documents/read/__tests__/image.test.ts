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

  // The model API refuses an image with a side over 8000 px, whatever its size in bytes
  // ("At least one of the image dimensions exceed max allowed size: 8000 pixels").
  const MODEL_MAX_SIDE_PX = 8000

  /** A receipt-like PNG: white with a dark line every 24 rows, so it compresses to a small file. */
  async function stripedPng(width: number, height: number): Promise<Buffer> {
    const raw = Buffer.alloc(width * height, 255)
    for (let y = 0; y < height; y += 24) raw.fill(30, y * width, (y + 1) * width)
    return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer()
  }

  it('shrinks a long receipt strip that is a small file but taller than the model takes', async () => {
    const strip = await stripedPng(600, 9000)
    expect(strip.length).toBeLessThan(IMAGE_DOWNSCALE_THRESHOLD_BYTES)
    const out = await fitImageForModel(strip, 'image/png')
    expect(out?.mediaType).toBe('image/jpeg')
    const meta = await sharp(out!.bytes).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(MODEL_MAX_SIDE_PX)
    // Fitted like every other photo, the aspect ratio kept: 600 x 9000 becomes 133 x 2000.
    expect(meta.height).toBe(IMAGE_MAX_DIMENSION)
    expect(meta.width).toBe(Math.round((600 * IMAGE_MAX_DIMENSION) / 9000))
  }, 30_000)

  it('shrinks an image wider than the model takes the same way', async () => {
    const out = await fitImageForModel(await stripedPng(9000, 600), 'image/png')
    expect(await sharp(out!.bytes).metadata()).toMatchObject({ format: 'jpeg', width: IMAGE_MAX_DIMENSION, height: Math.round((600 * IMAGE_MAX_DIMENSION) / 9000) })
  }, 30_000)

  it('leaves a small image exactly at the model limit as it is', async () => {
    const tall = await stripedPng(100, MODEL_MAX_SIDE_PX)
    expect(await fitImageForModel(tall, 'image/png')).toEqual({ bytes: tall, mediaType: 'image/png' })
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
