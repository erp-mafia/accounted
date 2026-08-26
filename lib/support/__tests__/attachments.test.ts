import { describe, it, expect } from 'vitest'
import {
  SUPPORT_ATTACHMENT_ACCEPT,
  SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES,
  isSupportedAttachmentType,
  sanitizeAttachmentFilename,
} from '@/lib/support/attachments'
import { HOSTED_MAX_UPLOAD_BYTES } from '@/lib/documents/upload-size'

describe('support attachments', () => {
  it('accepts the types a support reader can open', () => {
    expect(isSupportedAttachmentType('image/png')).toBe(true)
    expect(isSupportedAttachmentType('IMAGE/JPEG')).toBe(true)
    expect(isSupportedAttachmentType('application/pdf')).toBe(true)
  })

  it('rejects everything else, including a missing type', () => {
    expect(isSupportedAttachmentType('application/x-sh')).toBe(false)
    expect(isSupportedAttachmentType('image/heic')).toBe(false)
    expect(isSupportedAttachmentType(undefined)).toBe(false)
    expect(isSupportedAttachmentType('')).toBe(false)
  })

  it('offers the same list to the file picker', () => {
    expect(SUPPORT_ATTACHMENT_ACCEPT).toBe('image/jpeg,image/png,image/webp,application/pdf')
  })

  // Vercel kills the request before the route runs if the body is over its own
  // ceiling, so the budget has to leave room for the multipart envelope.
  it('stays under the platform request-body ceiling', () => {
    expect(SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES).toBeLessThan(HOSTED_MAX_UPLOAD_BYTES)
  })

  describe('sanitizeAttachmentFilename', () => {
    it('keeps an ordinary name', () => {
      expect(sanitizeAttachmentFilename('skarmbild.png')).toBe('skarmbild.png')
    })

    it('drops path segments from both separators', () => {
      expect(sanitizeAttachmentFilename('../../etc/passwd.png')).toBe('passwd.png')
      expect(sanitizeAttachmentFilename('C:\\Users\\emil\\bild.png')).toBe('bild.png')
    })

    it('strips control characters that would break a mail header', () => {
      const withNewline = `bild${String.fromCharCode(13)}${String.fromCharCode(10)}.png`
      expect(sanitizeAttachmentFilename(withNewline)).toBe('bild.png')
    })

    it('falls back when nothing usable is left', () => {
      expect(sanitizeAttachmentFilename('')).toBe('bilaga')
      expect(sanitizeAttachmentFilename(null)).toBe('bilaga')
      expect(sanitizeAttachmentFilename(String.fromCharCode(0))).toBe('bilaga')
    })

    it('bounds a very long name but keeps the extension', () => {
      const long = `${'a'.repeat(300)}.png`
      const result = sanitizeAttachmentFilename(long)
      expect(result.length).toBeLessThanOrEqual(100)
      expect(result.endsWith('.png')).toBe(true)
    })
  })
})
