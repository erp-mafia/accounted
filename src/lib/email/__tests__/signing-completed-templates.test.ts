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
  signers: ['Anna <Andersson>, VD', 'Erik Eriksson'],
  verifyUrl: 'https://app.accounted.se/verifiera',
  appName: 'Accounted',
}

describe('signing_completed mail', () => {
  it('says in the subject that everyone signed the document', () => {
    expect(generateSigningCompletedEmailSubject(data)).toBe('"Hyresavtal "Kontoret"" är signerat av alla')
  })

  it('names the document, the company, when it completed, everyone who signed, the attachment and where a copy is checked', () => {
    const text = generateSigningCompletedEmailText(data)
    expect(text).toContain('Alla har signerat "Hyresavtal "Kontoret"" för Bolaget & Co AB med BankID. Den sista underskriften kom 17 oktober 2026 kl. 14:05.')
    expect(text).toContain('- Anna <Andersson>, VD\n- Erik Eriksson')
    expect(text).toContain('Den signerade kopian är bifogad.')
    expect(text).toContain('https://app.accounted.se/verifiera')
  })

  it('escapes every value in the HTML', () => {
    const html = generateSigningCompletedEmailHtml(data)
    expect(html).toContain('Hyresavtal &quot;Kontoret&quot;')
    expect(html).toContain('Bolaget &amp; Co AB')
    expect(html).toContain('<li style="margin: 0 0 4px 0;">Anna &lt;Andersson&gt;, VD</li>')
    expect(html).not.toContain('<Andersson>')
    expect(html).toContain('href="https://app.accounted.se/verifiera"')
    expect(html).toContain('ACCOUNTED')
  })
})
