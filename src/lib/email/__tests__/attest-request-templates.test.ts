import { describe, expect, it } from 'vitest'
import {
  generateAttestRequestEmailHtml,
  generateAttestRequestEmailSubject,
  generateAttestRequestEmailText,
} from '../attest-request-templates'

const data = {
  companyName: 'Testbolaget AB',
  supplierName: 'Kontor & Co <AB>',
  invoiceNumber: 'F-1',
  arrivalNumber: 7,
  total: 12500,
  currency: 'SEK',
  dueDate: '2026-10-31',
  registeredBy: 'Cilla',
  approveUrl: 'https://app.example.se/attest/tok?beslut=godkann',
  rejectUrl: 'https://app.example.se/attest/tok?beslut=neka',
  expiresAt: '2026-10-21T09:00:00Z',
  appName: 'Accounted',
}

describe('attest request mail', () => {
  it('names the supplier and the amount in the subject', () => {
    expect(generateAttestRequestEmailSubject(data)).toMatch(/^Attestera Kontor & Co <AB> 12\s500\skr$/)
  })

  it('carries both buttons, escapes the supplier and says the link works without a login', () => {
    const html = generateAttestRequestEmailHtml(data)
    expect(html).toContain('href="https://app.example.se/attest/tok?beslut=godkann"')
    expect(html).toContain('href="https://app.example.se/attest/tok?beslut=neka"')
    expect(html).toContain('Kontor &amp; Co &lt;AB&gt;')
    expect(html).not.toContain('<AB>')
    expect(html).toContain('Du behöver inte logga in')
  })

  it('has both links in the text part, and the ankomstnummer when the invoice has no number', () => {
    const text = generateAttestRequestEmailText({ ...data, invoiceNumber: null })
    expect(text).toContain('Godkänn: https://app.example.se/attest/tok?beslut=godkann')
    expect(text).toContain('Neka: https://app.example.se/attest/tok?beslut=neka')
    expect(text).toContain('ankomstnummer 7')
  })
})
