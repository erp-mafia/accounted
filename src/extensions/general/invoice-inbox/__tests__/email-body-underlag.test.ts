import { describe, it, expect } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString, decodePDFRawStream } from 'pdf-lib'
import {
  SIGNATURE_IMAGE_MAX_BYTES,
  SUBSTANTIVE_BODY_MIN_CHARS,
  isSignatureImage,
  emailBodyToText,
  isSubstantiveBody,
  pdfSafeText,
  buildEmailBodyUnderlagModel,
  emailBodyUnderlagFilename,
  renderEmailBodyUnderlag,
} from '@/extensions/general/invoice-inbox/lib/email-body-underlag'
import { validateDocumentMagicBytes } from '@/lib/core/documents/document-service'

const RECEIPT_HTML = `
<html><body>
<table>
<tr><td>Spotify Premium</td><td>119,00 kr</td></tr>
<tr><td>Moms 25%</td><td>23,80 kr</td></tr>
<tr><td><b>Totalt</b></td><td><b>119,00 kr</b></td></tr>
</table>
<p>Ordernummer: 4711-2026 &amp; tack för ditt köp!</p>
<img src="cid:logo@x" alt="">
</body></html>`

const forwardedText = (body: string) =>
  `---------- Forwarded message ---------\nFrån: Spotify <no-reply@spotify.com>\nDate: tors 18 sep. 2026 kl 14:03\nSubject: Ditt kvitto\nTo: <anna@example.se>\n\n${body}`

describe('isSignatureImage', () => {
  const base = { content_type: 'image/png', content_disposition: 'inline', content_id: 'logo@x', size: 12_000 }

  it('classifies a small inline image as a signature image', () => {
    expect(isSignatureImage(base)).toBe(true)
    expect(isSignatureImage({ ...base, content_type: 'image/gif', size: 43 })).toBe(true)
    expect(isSignatureImage({ ...base, content_disposition: 'INLINE; filename="image001.png"' })).toBe(true)
    // Resend can leave the header unnormalised or missing; a content id
    // means the part is referenced from the body.
    expect(isSignatureImage({ ...base, content_disposition: null })).toBe(true)
  })

  it('keeps everything that may be a receipt', () => {
    // A regular attachment, whatever its size.
    expect(isSignatureImage({ ...base, content_disposition: 'attachment' })).toBe(false)
    // Inline photos from a phone are far above the cut.
    expect(isSignatureImage({ ...base, content_type: 'image/jpeg', size: SIGNATURE_IMAGE_MAX_BYTES + 1 })).toBe(false)
    // Size unknown: keep.
    expect(isSignatureImage({ ...base, size: null })).toBe(false)
    expect(isSignatureImage({ ...base, size: undefined })).toBe(false)
    // Not an image.
    expect(isSignatureImage({ ...base, content_type: 'application/pdf', size: 900 })).toBe(false)
    // No disposition and no content id: not an inline part.
    expect(isSignatureImage({ ...base, content_disposition: null, content_id: null })).toBe(false)
  })
})

describe('emailBodyToText', () => {
  it('flattens the HTML part when there is no text part', () => {
    const text = emailBodyToText(RECEIPT_HTML, null)
    expect(text).toContain('Spotify Premium 119,00 kr')
    expect(text).toContain('Ordernummer: 4711-2026 & tack för ditt köp!')
    expect(text).not.toContain('<')
  })

  it("prefers the sender's text part when it is a complete rendering", () => {
    const text = emailBodyToText(RECEIPT_HTML, 'Spotify Premium\t119,00 kr\r\nMoms 25%\t23,80 kr\r\nTotalt\t119,00 kr\r\nOrdernummer: 4711-2026')
    expect(text.startsWith('Spotify Premium')).toBe(true)
    expect(text).not.toContain('\r')
  })

  it('falls back to the HTML part when the text part is a stub', () => {
    const text = emailBodyToText(RECEIPT_HTML, 'Din e-postklient stöder inte HTML.')
    expect(text).toContain('Spotify Premium 119,00 kr')
  })

  it('returns an empty string for a mail without a body', () => {
    expect(emailBodyToText(null, null)).toBe('')
    expect(emailBodyToText('  ', ' \n ')).toBe('')
    expect(emailBodyToText('<div><br></div>', null)).toBe('')
  })
})

describe('isSubstantiveBody', () => {
  it('rejects mail-client notes and accepts a forwarded receipt', () => {
    expect(isSubstantiveBody('Skickat från min iPhone')).toBe(false)
    expect(isSubstantiveBody('x'.repeat(SUBSTANTIVE_BODY_MIN_CHARS - 1))).toBe(false)
    expect(isSubstantiveBody(forwardedText('Spotify Premium 119,00 kr\nTotalt 119,00 kr'))).toBe(true)
  })
})

describe('pdfSafeText', () => {
  it('keeps Swedish text and the WinAnsi punctuation set', () => {
    // U+2013 and U+2014 are in WinAnsi and must survive; built from code
    // points so the source carries no literal dash.
    const enDash = String.fromCharCode(0x2013)
    const emDash = String.fromCharCode(0x2014)
    const text = `Räksmörgås 45,50 kr ${enDash} “citat” ${emDash} • 10 € … ©`
    expect(pdfSafeText(text)).toBe(text)
  })

  it('maps spaces and dashes the standard fonts lack, drops invisibles and emoji, marks the rest', () => {
    const minus = String.fromCharCode(0x2212)
    const nnbsp = String.fromCharCode(0x202f)
    const zwsp = String.fromCharCode(0x200b)
    const softHyphen = String.fromCharCode(0xad)
    const nbHyphen = String.fromCharCode(0x2011)
    expect(pdfSafeText(`${minus}1${nnbsp}250 kr`)).toBe('-1 250 kr')
    expect(pdfSafeText(`Tack${zwsp} för${softHyphen} köpet 🎉 ✓`)).toBe('Tack för köpet  ')
    expect(pdfSafeText(`2026${nbHyphen}09`)).toBe('2026-09')
    expect(pdfSafeText('Спасибо')).toBe('???????')
    expect(pdfSafeText('a\tb\nc')).toBe('a    b\nc')
  })
})

describe('buildEmailBodyUnderlagModel', () => {
  const input = {
    from: 'Anna Andersson <anna@example.se>',
    to: ['acme-ab-x7f2@arcim.io'],
    subject: 'Fwd: Ditt kvitto',
    receivedAt: '2026-09-18T12:03:00Z',
    messageId: '<msg-1@example.se>',
    html: RECEIPT_HTML,
    text: null,
  }

  it('builds the header block and the body lines, and keeps the received parts', () => {
    const model = buildEmailBodyUnderlagModel(input)!
    expect(model.from).toBe('Anna Andersson <anna@example.se>')
    expect(model.to).toBe('acme-ab-x7f2@arcim.io')
    expect(model.subject).toBe('Fwd: Ditt kvitto')
    // Europe/Stockholm, CEST in September.
    expect(model.receivedAt).toBe('2026-09-18 14:03')
    expect(model.messageId).toBe('<msg-1@example.se>')
    expect(model.lines).toContain('Spotify Premium 119,00 kr')
    expect(model.truncated).toBe(false)
    expect(model.originals.map((o) => o.name)).toEqual(['original.html'])
    expect(new TextDecoder().decode(model.originals[0].bytes)).toBe(RECEIPT_HTML)
  })

  it('embeds both parts when the mail had both', () => {
    const model = buildEmailBodyUnderlagModel({ ...input, text: 'Ett textalternativ till samma kvitto' })!
    expect(model.originals.map((o) => o.name)).toEqual(['original.html', 'original.txt'])
  })

  it('collapses runs of blank lines', () => {
    const model = buildEmailBodyUnderlagModel({ ...input, html: null, text: 'Spotify Premium 119,00 kr\n\n\n\nTotalt 119,00 kr' })!
    expect(model.lines).toEqual(['Spotify Premium 119,00 kr', '', 'Totalt 119,00 kr'])
    expect(model.originals.map((o) => o.name)).toEqual(['original.txt'])
  })

  it('returns null for a mail without a body', () => {
    expect(buildEmailBodyUnderlagModel({ ...input, html: null, text: '  ' })).toBeNull()
  })

  it('applies the signature-image rule only when asked', () => {
    const note = { ...input, html: null, text: 'Skickat från min iPhone' }
    expect(buildEmailBodyUnderlagModel(note)).not.toBeNull()
    expect(buildEmailBodyUnderlagModel(note, { requireSubstantive: true })).toBeNull()
    expect(buildEmailBodyUnderlagModel({ ...input, text: forwardedText('Totalt 119,00 kr') }, { requireSubstantive: true })).not.toBeNull()
  })

  it('names the file after the subject with a safe fallback', () => {
    expect(emailBodyUnderlagFilename('Fwd: Ditt kvitto / september')).toBe('mail-Fwd__Ditt_kvitto___september.pdf')
    expect(emailBodyUnderlagFilename(null)).toBe('mail-meddelande.pdf')
  })
})

describe('renderEmailBodyUnderlag', () => {
  const input = {
    from: 'Anna Andersson <anna@example.se>',
    to: ['acme-ab-x7f2@arcim.io'],
    subject: 'Fwd: Ditt kvitto',
    receivedAt: '2026-09-18T12:03:00Z',
    messageId: '<msg-1@example.se>',
    html: RECEIPT_HTML,
    text: forwardedText('Spotify Premium 119,00 kr\nMoms 25% 23,80 kr\nTotalt 119,00 kr\nOrdernummer: 4711-2026'),
  }

  it('produces a PDF that passes the archive magic check, with the original parts embedded', async () => {
    const out = await renderEmailBodyUnderlag(input, { generatedAt: '2026-09-20' })
    expect(out).not.toBeNull()
    expect(out!.type).toBe('application/pdf')
    expect(out!.name).toBe('mail-Fwd__Ditt_kvitto.pdf')
    expect(validateDocumentMagicBytes(out!.buffer, 'application/pdf')).toBeNull()

    const pdf = await PDFDocument.load(out!.buffer, { updateMetadata: false })
    expect(pdf.getPageCount()).toBe(1)
    expect(pdf.getTitle()).toBe('Fwd: Ditt kvitto')
    expect(pdf.getKeywords()).toBe('<msg-1@example.se>')

    // The received parts sit in the catalog's EmbeddedFiles name tree,
    // byte for byte: the archive holds the form the mail arrived in.
    const names = pdf.catalog.lookup(PDFName.of('Names'), PDFDict)
    const embedded = names.lookup(PDFName.of('EmbeddedFiles'), PDFDict)
    const entries = embedded.lookup(PDFName.of('Names'), PDFArray)
    const files = new Map<string, string>()
    for (let i = 0; i < entries.size(); i += 2) {
      const name = (entries.lookup(i) as PDFString | PDFHexString).decodeText()
      const spec = entries.lookup(i + 1, PDFDict)
      const stream = spec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'), PDFStream) as PDFRawStream
      files.set(name, new TextDecoder().decode(decodePDFRawStream(stream).decode()))
    }
    expect([...files.keys()]).toEqual(['original.html', 'original.txt'])
    expect(files.get('original.html')).toBe(RECEIPT_HTML)
    expect(files.get('original.txt')).toBe(input.text)
  })

  it('renders long bodies and unbroken tokens without failing', async () => {
    const longToken = 'https://example.se/receipt/' + 'a'.repeat(600)
    const body = Array.from({ length: 400 }, (_, i) => `Rad ${i + 1}: artikel ${i + 1} 12,50 kr`).join('\n')
    const out = await renderEmailBodyUnderlag(
      { ...input, html: null, text: `${longToken}\n${body}` },
      { generatedAt: '2026-09-20' },
    )
    const pdf = await PDFDocument.load(out!.buffer, { updateMetadata: false })
    expect(pdf.getPageCount()).toBeGreaterThan(1)
  })

  it('returns null when there is nothing to render', async () => {
    expect(await renderEmailBodyUnderlag({ ...input, html: null, text: null })).toBeNull()
    expect(
      await renderEmailBodyUnderlag({ ...input, html: null, text: 'Skickat från min iPhone' }, { requireSubstantive: true }),
    ).toBeNull()
  })
})
