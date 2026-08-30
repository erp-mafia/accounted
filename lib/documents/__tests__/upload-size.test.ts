import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  HOSTED_MAX_UPLOAD_BYTES,
  HOSTED_REQUEST_BODY_LIMIT_BYTES,
  INBOX_MAX_UPLOAD_BYTES,
  exceedsHostedUploadLimit,
  exceedsInboxUploadLimit,
  formatMegabytes,
  inboxTooLargeMessage,
  isShrinkableImage,
  tooLargeMessage,
} from '../upload-size'
import { shrinkImageForUpload } from '../shrink-image'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('upload size limits', () => {
  it('stays under the platform ceiling so the multipart envelope fits', () => {
    expect(HOSTED_MAX_UPLOAD_BYTES).toBeLessThan(HOSTED_REQUEST_BODY_LIMIT_BYTES)
  })

  it('flags a file over the limit on hosted', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    expect(exceedsHostedUploadLimit(HOSTED_MAX_UPLOAD_BYTES + 1)).toBe(true)
    expect(exceedsHostedUploadLimit(HOSTED_MAX_UPLOAD_BYTES)).toBe(false)
  })

  // Docker self-hosting has no proxy in front of the app, so the route's own
  // MAX_FILE_SIZE governs and nothing should be refused or re-encoded here.
  it('never flags a file on self-hosted', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    expect(exceedsHostedUploadLimit(50 * 1024 * 1024)).toBe(false)
  })

  it('recognises the image types a canvas can re-encode', () => {
    expect(isShrinkableImage('image/jpeg')).toBe(true)
    expect(isShrinkableImage('image/HEIC')).toBe(true)
    expect(isShrinkableImage('application/pdf')).toBe(false)
    expect(isShrinkableImage('')).toBe(false)
    expect(isShrinkableImage(null)).toBe(false)
  })

  it('names both the actual size and the ceiling', () => {
    const message = tooLargeMessage(6 * 1024 * 1024)
    expect(message).toContain('6,0 MB')
    expect(message).toContain(formatMegabytes(HOSTED_MAX_UPLOAD_BYTES))
  })
})

// The inbox ceiling is the route's own MAX_FILE_SIZE (10 MB), mirrored here
// because core components cannot import from the extension. Files between
// the hosted body limit and this one take the direct-to-storage path.
describe('inbox upload ceiling', () => {
  it('sits above the hosted body limit and matches the route promise of 10 MB', () => {
    expect(INBOX_MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024)
    expect(INBOX_MAX_UPLOAD_BYTES).toBeGreaterThan(HOSTED_REQUEST_BODY_LIMIT_BYTES)
  })

  it('applies on every deployment: self-hosted has the same route cap', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    expect(exceedsInboxUploadLimit(INBOX_MAX_UPLOAD_BYTES + 1)).toBe(true)
    expect(exceedsInboxUploadLimit(INBOX_MAX_UPLOAD_BYTES)).toBe(false)
  })

  it('names the actual size and the inbox ceiling, not the hosted one', () => {
    const message = inboxTooLargeMessage(12 * 1024 * 1024)
    expect(message).toContain('12,0 MB')
    expect(message).toContain(formatMegabytes(INBOX_MAX_UPLOAD_BYTES))
    expect(message).not.toContain(formatMegabytes(HOSTED_MAX_UPLOAD_BYTES))
  })
})

describe('shrinkImageForUpload', () => {
  function fakeFile(size: number, type: string): File {
    return { size, type, name: 'kvitto.heic', lastModified: 0 } as File
  }

  it('returns a file that already fits untouched', async () => {
    const file = fakeFile(1024, 'image/jpeg')
    expect(await shrinkImageForUpload(file)).toBe(file)
  })

  it('returns a PDF untouched: there is nothing a canvas can do with it', async () => {
    const file = fakeFile(9 * 1024 * 1024, 'application/pdf')
    expect(await shrinkImageForUpload(file)).toBe(file)
  })

  // No createImageBitmap outside a browser (and none for HEIC outside Safari):
  // the caller falls back to the size message rather than a silent failure.
  it('returns the original where the browser cannot decode it', async () => {
    const file = fakeFile(9 * 1024 * 1024, 'image/heic')
    expect(await shrinkImageForUpload(file)).toBe(file)
  })
})
