import { describe, expect, it } from 'vitest'
import {
  generateSigningCompletedEmailHtml,
  generateSigningCompletedEmailSubject,
  generateSigningCompletedEmailText,
} from '../signing-completed-templates'

const data = {
  companyName: 'Bolaget & Co AB',
  title: 'Hyresavtal "Kontoret"',
  completedAt: '2026-10-17T12:05:00.000Z',
  signers: [
    { name: 'Anna <Andersson>', role: 'VD', signedAt: '2026-10-17T11:00:00.000Z' },
    { name: 'Erik Eriksson', role: null, signedAt: '2026-10-17T12:05:00.000Z' },
  ],
  pageCount: 3,
  verifyUrl: 'https://app.accounted.se/verifiera',
  logo: { src: 'https://storage.example.test/logos/c/logo-1.png', width: 160, height: 40 },
  platformName: 'Accounted',
}

describe('signing_completed mail', () => {
  it('says "Signerat:" and the title in the subject', () => {
    expect(generateSigningCompletedEmailSubject(data)).toBe('Signerat: Hyresavtal "Kontoret"')
  })

  it('draws the request mail look: the logo, the heading and the document card with every signer', () => {
    const html = generateSigningCompletedEmailHtml(data)
    expect(html).toContain('<img src="https://storage.example.test/logos/c/logo-1.png" width="160" height="40" alt="Bolaget &amp; Co AB"')
    expect(html).toContain('Dokumentet är signerat av alla</h1>')
    expect(html).toContain('3 sidor &middot; 2 av 2 har signerat &middot; slutfört 17 oktober 2026 kl. 14:05')
    expect(html).toContain('Anna &lt;Andersson&gt;<br><span style="font-size: 13px; color: #6b6862;">VD</span>')
    expect(html).toContain('Erik Eriksson<br><span style="font-size: 13px; color: #6b6862;">Undertecknare</span>')
    expect(html).toContain('17 okt 2026, 13:00<br>BankID')
    expect(html).not.toContain('<Andersson>')
    expect(html).toContain('Signeringsbeviset sist i dokumentet visar vem som skrev under, som vad och när.')
    expect(generateSigningCompletedEmailHtml({ ...data, logo: null })).toContain('>BC</td>')
  })

  it('links the verify page by its bare address and says whom it was sent for', () => {
    const html = generateSigningCompletedEmailHtml(data)
    expect(html).toContain('<a href="https://app.accounted.se/verifiera" style="color: #6b6862;">app.accounted.se/verifiera</a>')
    expect(html).toContain('Skickat för Bolaget &amp; Co AB med Accounted.')
    expect(html.match(/<a /g)).toHaveLength(1)
  })

  it('carries the same in the text version', () => {
    expect(generateSigningCompletedEmailText(data)).toBe(
      [
        'Dokumentet är signerat av alla.',
        '',
        'Hyresavtal "Kontoret"',
        '3 sidor · 2 av 2 har signerat · slutfört 17 oktober 2026 kl. 14:05',
        '',
        '- Anna <Andersson>, VD (17 okt 2026, 13:00, BankID)',
        '- Erik Eriksson (17 okt 2026, 14:05, BankID)',
        '',
        'Den signerade kopian är bifogad. Signeringsbeviset sist i dokumentet visar vem som skrev under, som vad och när.',
        '',
        'Vill någon kontrollera att en kopia är äkta kan den laddas upp på https://app.accounted.se/verifiera.',
        '',
        'Skickat för Bolaget & Co AB med Accounted.',
      ].join('\n'),
    )
  })

  it('never uses an em or en dash', () => {
    for (const out of [generateSigningCompletedEmailSubject(data), generateSigningCompletedEmailText(data), generateSigningCompletedEmailHtml(data)]) {
      expect(out).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
