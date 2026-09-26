import { describe, it, expect, vi, beforeEach } from 'vitest'
import sharp from 'sharp'

const decodeHeicMock = vi.fn()
vi.mock('@/lib/documents/read/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/read/image')>()),
  decodeHeicToJpeg: (...args: unknown[]) => decodeHeicMock(...args),
}))

import { ensurePreview, makePreview, needsPreview, previewPath, PREVIEW_MIN_BYTES } from '../preview'

const photo = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 160 } } }).jpeg({ quality: 95 }).toBuffer()

function makeStorage(files: Record<string, Buffer | undefined>) {
  const uploads: Array<{ path: string; bytes: Buffer; contentType?: string }> = []
  const bucket = {
    download: vi.fn(async (path: string) => {
      const bytes = files[path]
      return bytes ? { data: new Blob([new Uint8Array(bytes)]), error: null } : { data: null, error: { message: 'Object not found' } }
    }),
    upload: vi.fn(async (path: string, bytes: Buffer, opts: { contentType?: string }) => {
      uploads.push({ path, bytes, contentType: opts.contentType })
      return { error: null }
    }),
  }
  return { client: { storage: { from: () => bucket } } as never, bucket, uploads }
}

const doc = { id: 'doc-1', company_id: 'co-1', mime: 'image/jpeg', storage_path: 'documents/co-1/u/doc-1.jpg' }

beforeEach(() => vi.clearAllMocks())

describe('needsPreview', () => {
  it('previews every HEIC and a photo large enough to shrink; PDFs, small photos and rows without a size go as they are', () => {
    expect(needsPreview('image/heic', null)).toBe(true)
    expect(needsPreview('image/heif', 10)).toBe(true)
    expect(needsPreview('image/jpeg', PREVIEW_MIN_BYTES + 1)).toBe(true)
    expect(needsPreview('image/png', 5_000_000)).toBe(true)
    expect(needsPreview('image/jpeg', 80_000)).toBe(false)
    expect(needsPreview('image/jpeg', null)).toBe(false)
    expect(needsPreview('application/pdf', 9_000_000)).toBe(false)
  })

  it('keeps previews outside the documents/ prefix members can read', () => {
    expect(previewPath('co-1', 'doc-1')).toBe('previews/co-1/doc-1-v1.jpg')
  })
})

describe('makePreview', () => {
  it('shrinks a large photo to at most 2000 px on the long edge, as JPEG', async () => {
    const out = await makePreview(await photo(4000, 3000), 'image/jpeg')
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('jpeg')
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(2000)
  })

  it('decodes a HEIC first, since sharp cannot', async () => {
    decodeHeicMock.mockResolvedValue(await photo(3000, 1000))
    const out = await makePreview(Buffer.from('HEIC'), 'image/heic')
    expect(decodeHeicMock).toHaveBeenCalledTimes(1)
    expect((await sharp(out).metadata()).width).toBe(2000)
  })
})

describe('ensurePreview', () => {
  it('returns the kept preview without touching the original', async () => {
    const kept = Buffer.from('KEPT')
    const { client, bucket, uploads } = makeStorage({ 'previews/co-1/doc-1-v1.jpg': kept })
    expect(await ensurePreview(client, doc)).toEqual(kept)
    expect(bucket.download).toHaveBeenCalledTimes(1)
    expect(uploads).toEqual([])
  })

  it('makes it once from the original and keeps it under previews/', async () => {
    const { client, uploads } = makeStorage({ [doc.storage_path]: await photo(3000, 2000) })
    const out = await ensurePreview(client, doc)
    expect(out).not.toBeNull()
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({ path: 'previews/co-1/doc-1-v1.jpg', contentType: 'image/jpeg' })
  })

  it('never throws: no original, or no storage at all, gives null so the caller serves the file', async () => {
    expect(await ensurePreview(makeStorage({}).client, doc)).toBeNull()
    expect(await ensurePreview({} as never, doc)).toBeNull()
  })
})
