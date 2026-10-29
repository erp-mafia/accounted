import { describe, expect, it } from 'vitest'
import {
  generateSigningRequestEmailHtml,
  generateSigningRequestEmailSubject,
  generateSigningRequestEmailText,
} from '../signing-request-templates'

const data = {
  companyName: 'Bolaget & Co AB',
  requester: 'Karin <Byrå> Andersson',
  title: 'Hyresavtal "Kontoret"',
  signingUrl: 'https://app.accounted.se/signera/abc_DEF-123',
  expiresAt: '2026-10-17T12:05:00.000Z',
  message: 'Hej! Skriv under <3\nTack',
  pageCount: 3,
  signerCount: 2,
  logo: { src: 'https://storage.example.test/logos/c/logo-1.png', width: 47, height: 48 },
  platformName: 'Accounted',
}

describe('signing_request mail', () => {
  it('says "Signera:" and the title in the subject, and marks a reminder', () => {
    expect(generateSigningRequestEmailSubject(data)).toBe('Signera: Hyresavtal "Kontoret"')
    expect(generateSigningRequestEmailSubject({ ...data, reminder: true })).toBe('Signera: Hyresavtal "Kontoret" (påminnelse)')
    expect(generateSigningRequestEmailSubject({ ...data, title: 'Två\r\nrader' })).toBe('Signera: Två rader')
  })

  it('heads with who asks on behalf of which company, or the company alone when it asks itself', () => {
    expect(generateSigningRequestEmailHtml(data)).toContain('Karin &lt;Byrå&gt; Andersson på Bolaget &amp; Co AB ber dig signera ett dokument</h1>')
    expect(generateSigningRequestEmailHtml({ ...data, requester: ' bolaget & co ab ' })).toContain('>Bolaget &amp; Co AB ber dig signera ett dokument</h1>')
    expect(generateSigningRequestEmailHtml({ ...data, reminder: true })).toContain('Karin &lt;Byrå&gt; Andersson på Bolaget &amp; Co AB väntar på din underskrift</h1>')
    expect(generateSigningRequestEmailText({ ...data, requester: 'Bolaget & Co AB', reminder: true }).split('\n')[0]).toBe('Bolaget & Co AB väntar på din underskrift.')
  })

  it('names the title only once, in the document card with the pages, the signers and when the link runs out', () => {
    const html = generateSigningRequestEmailHtml(data)
    expect(html.match(/Hyresavtal &quot;Kontoret&quot;/g)).toHaveLength(2) // the card and the <title>
    expect(html).toContain('3 sidor &middot; 2 undertecknare &middot; gäller till 17 oktober kl. 14:05')
    expect(generateSigningRequestEmailHtml({ ...data, pageCount: 1, signerCount: 1 })).toContain('1 sida &middot; 1 undertecknare &middot;')
    // Unknown counts are left out, never printed as zero.
    expect(generateSigningRequestEmailHtml({ ...data, pageCount: null, signerCount: undefined })).toContain('>gäller till 17 oktober kl. 14:05</div>')
  })

  it('quotes the message with its line breaks, escaped', () => {
    const html = generateSigningRequestEmailHtml(data)
    expect(html).toContain('&rdquo;Hej! Skriv under &lt;3<br>Tack&rdquo;')
    for (const message of [null, undefined, '   ']) expect(generateSigningRequestEmailHtml({ ...data, message })).not.toContain('&rdquo;')
  })

  it('has exactly one link, the button "Läs och signera"', () => {
    const html = generateSigningRequestEmailHtml(data)
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).toContain('href="https://app.accounted.se/signera/abc_DEF-123"')
    expect(html).toContain('>Läs och signera</a>')
    expect(html).toContain('Inget är signerat förrän du godkänner i BankID-appen.')
  })

  it('draws the company logo at its size, or the company initials without one', () => {
    const html = generateSigningRequestEmailHtml(data)
    expect(html).toContain('<img src="https://storage.example.test/logos/c/logo-1.png" width="47" height="48" alt="Bolaget &amp; Co AB"')
    const plain = generateSigningRequestEmailHtml({ ...data, logo: null })
    expect(plain).not.toContain('<img')
    expect(plain).toContain('>BC</td>')
  })

  it('says whom it was sent for and through which platform, and that the link is personal', () => {
    expect(generateSigningRequestEmailHtml(data)).toContain('Skickat för Bolaget &amp; Co AB med Accounted. Länken är personlig, vidarebefordra inte mejlet.')
    expect(generateSigningRequestEmailHtml({ ...data, platformName: 'Byrån Ekonomi' })).toContain('med Byrån Ekonomi.')
  })

  it('escapes a hostile title, message and link so nothing opens a tag or leaves an attribute', () => {
    const html = generateSigningRequestEmailHtml({ ...data, title: '"><script>alert(1)</script>', signingUrl: 'https://app.accounted.se/signera/x"onmouseover="y' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
    expect(html).not.toContain('x"onmouseover')
    expect(html).toContain('href="https://app.accounted.se/signera/x&quot;onmouseover=&quot;y"')
  })

  it('carries the same in the text version, with the link in clear', () => {
    expect(generateSigningRequestEmailText(data)).toBe(
      [
        'Karin <Byrå> Andersson på Bolaget & Co AB ber dig signera ett dokument.',
        '',
        'Hyresavtal "Kontoret"',
        '3 sidor · 2 undertecknare · gäller till 17 oktober kl. 14:05',
        '',
        '”Hej! Skriv under <3\nTack”',
        '',
        'Läs och signera: https://app.accounted.se/signera/abc_DEF-123',
        '',
        'Du läser dokumentet och signerar med BankID. Inget är signerat förrän du godkänner i BankID-appen.',
        '',
        'Skickat för Bolaget & Co AB med Accounted. Länken är personlig, vidarebefordra inte mejlet.',
      ].join('\n'),
    )
    expect(generateSigningRequestEmailText({ ...data, message: null })).not.toContain('”')
  })

  it('never uses an em or en dash', () => {
    for (const reminder of [false, true]) {
      for (const logo of [data.logo, null]) {
        const d = { ...data, reminder, logo }
        for (const out of [generateSigningRequestEmailSubject(d), generateSigningRequestEmailText(d), generateSigningRequestEmailHtml(d)]) {
          expect(out).not.toMatch(/[\u2013\u2014]/)
        }
      }
    }
  })
})
