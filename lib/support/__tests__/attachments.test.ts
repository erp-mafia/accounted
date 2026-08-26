import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  SUPPORT_ATTACHMENT_ACCEPT,
  SUPPORT_MAX_ATTACHMENTS,
  SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES,
  SUPPORT_MAX_ATTACHMENT_TOTAL_MB,
  isSupportedAttachmentType,
  sanitizeAttachmentFilename,
  supportAttachmentFilename,
} from '@/lib/support/attachments'
import { HOSTED_REQUEST_BODY_LIMIT_BYTES } from '@/lib/documents/upload-size'

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

  it('allows five files with a four megabyte combined budget', () => {
    expect(SUPPORT_MAX_ATTACHMENTS).toBe(5)
    expect(SUPPORT_MAX_ATTACHMENT_TOTAL_MB).toBe(4)
    expect(SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES).toBe(4 * 1024 * 1024)
  })

  // Vercel kills the request before the route runs if the body is over its own
  // ceiling, so the budget has to leave room for the multipart envelope.
  it('stays under the platform request-body ceiling', () => {
    expect(SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES).toBeLessThan(HOSTED_REQUEST_BODY_LIMIT_BYTES)
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

  describe('supportAttachmentFilename', () => {
    it('forces the extension to agree with the verified MIME type', () => {
      expect(supportAttachmentFilename('update.exe', 'application/pdf')).toBe('update.pdf')
      expect(supportAttachmentFilename('photo.png', 'image/jpeg')).toBe('photo.jpg')
    })

    it('keeps the final filename within the mail-header bound', () => {
      const filename = supportAttachmentFilename('a'.repeat(150), 'application/pdf')
      expect(filename.length).toBeLessThanOrEqual(100)
    })
  })

  it('does not expose attachment names in session-replay attributes', () => {
    const source = readFileSync(
      join(process.cwd(), 'components', 'ui', 'support-link.tsx'),
      'utf8'
    )
    expect(source).toContain('ph-no-capture')
    expect(source).not.toContain('title={file.name}')
  })
})
