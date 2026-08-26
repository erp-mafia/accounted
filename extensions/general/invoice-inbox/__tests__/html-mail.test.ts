import { describe, it, expect } from 'vitest'
import {
  ensureHtmlDocument,
  buildEmailBodyHtmlDocument,
  EMAIL_ALLOWED_MIME_TYPES,
  UPLOAD_ALLOWED_MIME_TYPES,
} from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import { htmlToText } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'
import { validateDocumentMagicBytes } from '@/lib/core/documents/document-service'

const decode = (buf: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(buf))

describe('EMAIL_ALLOWED_MIME_TYPES', () => {
  it('is the upload set plus text/html, and only reachable from the email pipeline', () => {
    for (const type of UPLOAD_ALLOWED_MIME_TYPES) {
      expect(EMAIL_ALLOWED_MIME_TYPES.has(type)).toBe(true)
    }
    expect(EMAIL_ALLOWED_MIME_TYPES.has('text/html')).toBe(true)
    // The manual upload surface must stay strict.
    expect(UPLOAD_ALLOWED_MIME_TYPES.has('text/html')).toBe(false)
  })
})

describe('ensureHtmlDocument', () => {
  it('wraps a fragment-shaped mail body into a full document', () => {
    const out = decode(ensureHtmlDocument('<div>Faktura 123</div>'))
    expect(out.toLowerCase().startsWith('<!doctype html')).toBe(true)
    expect(out).toContain('<meta charset="utf-8">')
    expect(out).toContain('<div>Faktura 123</div>')
  })

  it('passes a full document through unchanged', () => {
    const full = '<!DOCTYPE html>\n<html><body>Hej</body></html>'
    expect(decode(ensureHtmlDocument(full))).toBe(full)
    const rooted = '<html><body>Hej</body></html>'
    expect(decode(ensureHtmlDocument(rooted))).toBe(rooted)
  })

  it('recognises a full document behind leading whitespace', () => {
    const full = '\n  <!doctype html><html></html>'
    expect(decode(ensureHtmlDocument(full))).toBe(full)
  })

  it('produces bytes that pass the document-service magic check', () => {
    expect(
      validateDocumentMagicBytes(ensureHtmlDocument('<td>999 kr</td>'), 'text/html'),
    ).toBeNull()
  })
})

describe('buildEmailBodyHtmlDocument', () => {
  it('prefers the HTML part over the text part', () => {
    const out = decode(buildEmailBodyHtmlDocument('<p>Belopp: 100 kr</p>', 'plain fallback')!)
    expect(out).toContain('<p>Belopp: 100 kr</p>')
    expect(out).not.toContain('plain fallback')
  })

  it('escapes a plain-text-only body into a <pre>', () => {
    const out = decode(
      buildEmailBodyHtmlDocument(null, 'Total <script>alert(1)</script> & 100 kr')!,
    )
    expect(out).toContain('<pre>')
    expect(out).toContain('Total &lt;script&gt;alert(1)&lt;/script&gt; &amp; 100 kr')
    expect(out).not.toContain('<script>')
  })

  it('returns null when the mail has no body worth storing', () => {
    expect(buildEmailBodyHtmlDocument(null, null)).toBeNull()
    expect(buildEmailBodyHtmlDocument('   ', ' \n ')).toBeNull()
  })
})

describe('htmlToText', () => {
  it('drops script/style/head blocks and comments', () => {
    const text = htmlToText(
      '<html><head><title>x</title><style>.a{color:red}</style></head>' +
        '<body><script>evil()</script><!-- hidden --><p>Faktura 42</p></body></html>',
    )
    expect(text).toBe('Faktura 42')
  })

  it('keeps block boundaries as newlines so labels and amounts stay separated', () => {
    const text = htmlToText('<table><tr><td>Att betala</td></tr><tr><td>1 234,56 kr</td></tr></table>')
    expect(text).toContain('Att betala')
    expect(text).toContain('1 234,56 kr')
    expect(text.split('\n').length).toBeGreaterThan(1)
  })

  it('decodes entities, ampersand strictly last', () => {
    expect(htmlToText('Moms &amp; frakt: 25&nbsp;kr')).toBe('Moms & frakt: 25 kr')
    // Double-decoding would turn this into a real "<" instead of the literal.
    expect(htmlToText('visar &amp;lt; som text')).toBe('visar &lt; som text')
    expect(htmlToText('&#8364;100 och &#x27;citat&#x27;')).toBe("€100 och 'citat'")
  })

  it('caps the output length', () => {
    const long = `<p>${'a'.repeat(80_000)}</p>`
    expect(htmlToText(long).length).toBeLessThanOrEqual(50_000)
  })
})
