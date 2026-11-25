import { describe, it, expect } from 'vitest'
import {
  ensureHtmlDocument,
  EMAIL_ALLOWED_MIME_TYPES,
  UPLOAD_ALLOWED_MIME_TYPES,
} from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import { htmlToText } from '@/lib/documents/inbox-extraction/extract-invoice-fields'
import { MAIL_HTML_FIXTURES } from '@/tests/fixtures/mail-html'
import { validateDocumentMagicBytes } from '@/lib/core/documents/document-service'
import { INBOX_UPLOAD_ACCEPT, INBOX_UPLOAD_TYPES, declaredDocumentType } from '@/lib/documents/upload-types'

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

describe('UPLOAD_ALLOWED_MIME_TYPES', () => {
  it('is the list the inbox pickers offer from, so a picker never offers what this route refuses', () => {
    expect([...UPLOAD_ALLOWED_MIME_TYPES].sort()).toEqual([...INBOX_UPLOAD_TYPES].sort())
    for (const ext of INBOX_UPLOAD_ACCEPT.split(',')) {
      expect(UPLOAD_ALLOWED_MIME_TYPES.has(declaredDocumentType({ name: `f${ext}`, type: '' }))).toBe(true)
    }
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

describe('htmlToText on mail as senders write it', () => {
  const READ: Record<string, string> = {
    'an Outlook invoice mail':
      'Hej,\nBifogat finns faktura 2025-0042 f&ouml;r november.\nAtt betala: 12 500,00 kr inkl. moms. F&ouml;rfallodag 2025-12-31.\nBankgiro 123-4567, OCR 20250042.\nMed v&auml;nliga h&auml;lsningar\nAnna Exempel\nExempel Leverant&ouml;r AB',
    'a web shop receipt':
      'Tack f&ouml;r ditt k&ouml;p!\nOrdernummer: 100-2381\nKontorsstol Ergo & fotst&ouml;d 2\u00a0990,00 kr\nFrakt 49,00 kr\nTotalt 3\u00a0039,00 kr\nVarav moms 25 %: 607,80 kr',
    'a receipt forwarded from Gmail':
      '---------- Forwarded message ---------\nFrån: Exempel Hosting <faktura@hosting.example>\nDate: tis 25 nov. 2025 kl 09:14\nSubject: Kvitto för betalning #48213\nTo: <ekonomi@foretaget.example>\nHej!\nVi har tagit emot din betalning på 1 249,00 kr för perioden 2025-11-01 till 2025-11-30.\nWebbhotell Bas: 999,00 kr\nDomän foretaget.example: 250,00 kr\nKortet slutar på 4242.\nDetta mejl kan inte besvaras.',
    'a page saved from a supplier portal':
      'Exempel Leverant&ouml;r AB\nFaktura 7781\nFakturadatum: 2025-11-03\nFörfallodag: 2025-12-03\nKonsulttimmar, 10 h 9\u00a0500,00\nMoms 25 % 2 375,00\nSumma att betala: 11 875,00 SEK\nBet.villkor 30 dagar netto. Dr&ouml;jsm&aring;lsr&auml;nta enligt r&auml;ntelagen.\n<!-- generated 2025-11-03T08:00:00Z',
  }

  it.each(MAIL_HTML_FIXTURES)('reads %s as before', (name, html) => {
    expect(htmlToText(html)).toBe(READ[name])
  })

  it('ends a comment at --!> as browsers do, so the text after it is kept', () => {
    expect(htmlToText('<p>a</p><!-- x --!><p>b</p><!-- y -->')).toBe('a\nb')
  })

  // Each of these took seconds per 100 KB, searching the rest of the body
  // again from every opening. The bound is checked after each size, the
  // smaller first, so a slow step fails here instead of hanging the run.
  it.each([
    ['opening script tags without their >', '<script '],
    ['opening title tags without their >', '<title '],
    ['comments that never end', '<!--'],
    ['line breaks without their >', '<br '],
    ['rules without their >', '<hr '],
    ['tags without their >', '<'],
    ['a run of no-break spaces', '\u00a0'],
    ['a run of carriage returns', '\r'],
  ])('answers at once for a body made of %s', (_, unit) => {
    const started = Date.now()
    for (const kb of [256, 1024]) {
      htmlToText(unit.repeat(Math.floor((kb * 1024) / unit.length)))
      expect(Date.now() - started).toBeLessThan(2000)
    }
  })
})
