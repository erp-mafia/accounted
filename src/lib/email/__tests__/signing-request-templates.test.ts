import { describe, expect, it } from 'vitest'
import {
  generateSigningRequestEmailHtml,
  generateSigningRequestEmailSubject,
  generateSigningRequestEmailText,
} from '../signing-request-templates'

const data = {
  companyName: 'Bolaget & Co AB',
  requester: 'Byrån <Ekonomi> AB',
  title: 'Hyresavtal "Kontoret"',
  signingUrl: 'https://app.accounted.se/signera/abc_DEF-123',
  expiresAt: '2026-10-17T12:05:00.000Z',
  message: 'Hej! Skriv under <3\nTack',
  appName: 'Accounted',
}

describe('signing_request mail', () => {
  it('names the document, the company and BankID in the subject, and says so when it is a reminder', () => {
    expect(generateSigningRequestEmailSubject(data)).toBe('Signera "Hyresavtal "Kontoret"" från Bolaget & Co AB med BankID')
    expect(generateSigningRequestEmailSubject({ ...data, reminder: true })).toBe('Påminnelse: Signera "Hyresavtal "Kontoret"" från Bolaget & Co AB med BankID')
  })

  it('says who asks, what to sign, the message, the URL in clear text and when the link runs out', () => {
    const text = generateSigningRequestEmailText(data)
    expect(text).toContain('Byrån <Ekonomi> AB ber dig signera "Hyresavtal "Kontoret"" för Bolaget & Co AB med BankID.')
    expect(text).toContain('Hej! Skriv under <3\nTack')
    expect(text).toContain('Läs och signera: https://app.accounted.se/signera/abc_DEF-123')
    expect(text).toContain('Inget är signerat förrän du har godkänt i BankID-appen.')
    expect(text).toContain('gäller till 17 oktober 2026 kl. 14:05')
  })

  it('tells a reminder apart in the text and the HTML', () => {
    expect(generateSigningRequestEmailText({ ...data, reminder: true })).toContain('väntar fortfarande på din underskrift av "Hyresavtal "Kontoret""')
    expect(generateSigningRequestEmailHtml({ ...data, reminder: true })).toContain('väntar fortfarande på din underskrift av')
    expect(generateSigningRequestEmailHtml(data)).toContain('ber dig signera')
  })

  it('escapes every name, the title and the message in the HTML', () => {
    const html = generateSigningRequestEmailHtml(data)
    expect(html).toContain('Bolaget &amp; Co AB')
    expect(html).not.toContain('Bolaget & Co AB')
    expect(html).toContain('Byrån &lt;Ekonomi&gt; AB')
    expect(html).not.toContain('<Ekonomi>')
    expect(html).toContain('Hyresavtal &quot;Kontoret&quot;')
    expect(html).toContain('Skriv under &lt;3')
    expect(html).toContain('<title>Signera Hyresavtal &quot;Kontoret&quot;</title>')
  })

  it('escapes a hostile title so it cannot open a tag or leave an attribute', () => {
    const html = generateSigningRequestEmailHtml({ ...data, title: '"><script>alert(1)</script>', signingUrl: 'https://app.accounted.se/signera/x"onmouseover="y' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
    expect(html).not.toContain('x"onmouseover')
    expect(html).toContain('href="https://app.accounted.se/signera/x&quot;onmouseover=&quot;y"')
  })

  it('shows the URL in clear text beside the button', () => {
    const html = generateSigningRequestEmailHtml(data)
    expect(html.match(/href="https:\/\/app\.accounted\.se\/signera\/abc_DEF-123"/g)).toHaveLength(2)
    expect(html).toContain('Länken går till: <a href="https://app.accounted.se/signera/abc_DEF-123" style="color: #666;">https://app.accounted.se/signera/abc_DEF-123</a>')
    expect(html).toContain('Läs och signera')
    expect(html).toContain('gäller till 17 oktober 2026 kl. 14:05')
    expect(html).toContain('ACCOUNTED')
  })

  it('leaves the message out when there is none or it is blank', () => {
    for (const message of [null, undefined, '   ']) {
      const plain = { ...data, message }
      expect(generateSigningRequestEmailText(plain)).not.toContain('Skriv under')
      expect(generateSigningRequestEmailText(plain).split('\n')[1]).toBe('')
      expect(generateSigningRequestEmailHtml(plain)).not.toContain('border-left')
    }
  })

  it('never uses an em or en dash', () => {
    for (const reminder of [false, true]) {
      const d = { ...data, reminder }
      for (const out of [generateSigningRequestEmailSubject(d), generateSigningRequestEmailText(d), generateSigningRequestEmailHtml(d)]) {
        expect(out).not.toMatch(/[\u2013\u2014]/)
      }
    }
  })
})
