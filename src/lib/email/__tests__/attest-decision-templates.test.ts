import { describe, expect, it } from 'vitest'
import {
  generateAttestDecisionEmailHtml,
  generateAttestDecisionEmailSubject,
  generateAttestDecisionEmailText,
  type AttestDecisionEmailData,
  type AttestDecisionEmailInvoice,
} from '../attest-decision-templates'

const inv = (overrides: Partial<AttestDecisionEmailInvoice> = {}): AttestDecisionEmailInvoice => ({
  supplierName: 'Möbelfirman AB',
  invoiceNumber: 'F-100',
  arrivalNumber: 7,
  total: 29625,
  currency: 'SEK',
  dueDate: '2026-09-15',
  decision: 'approved',
  comment: null,
  ...overrides,
})

const data = (invoices: AttestDecisionEmailInvoice[]): AttestDecisionEmailData => ({
  companyName: 'Kundbolaget AB',
  attesterName: 'Kim',
  invoices,
  listUrl: 'https://byra.accounted.se/supplier-invoices?tab=to_pay',
  reason: 'registrant',
  appName: 'Byrån',
})

describe('attest decision mail', () => {
  it('names one invoice by supplier and amount, several by count, a mixed answer as an answer', () => {
    expect(generateAttestDecisionEmailSubject(data([inv()]))).toMatch(/^Kim godkände Möbelfirman AB 29\s625(,00)?\skr$/)
    expect(generateAttestDecisionEmailSubject(data([inv({ decision: 'rejected' })]))).toMatch(/^Kim nekade Möbelfirman AB/)
    expect(generateAttestDecisionEmailSubject(data([inv(), inv()]))).toBe('Kim godkände 2 fakturor till Kundbolaget AB')
    expect(generateAttestDecisionEmailSubject(data([inv({ decision: 'rejected' }), inv({ decision: 'rejected' })]))).toBe('Kim nekade 2 fakturor till Kundbolaget AB')
    expect(generateAttestDecisionEmailSubject(data([inv(), inv({ decision: 'rejected' })]))).toBe('Kim har svarat på 2 fakturor till Kundbolaget AB')
  })

  it('lists the attested ones as ready to pay and the rejected ones with the comment, escaped', () => {
    const mail = data([inv(), inv({ supplierName: 'Konsult <AB>', invoiceNumber: null, decision: 'rejected', comment: 'Fel belopp & datum' })])
    const html = generateAttestDecisionEmailHtml(mail)
    expect(html).toContain('Redo att betala')
    expect(html).toContain('Nekade')
    expect(html).toContain('Konsult &lt;AB&gt;, ankomstnummer 7')
    expect(html).toContain('Kommentar: Fel belopp &amp; datum')
    expect(html).toContain('href="https://byra.accounted.se/supplier-invoices?tab=to_pay"')
    expect(html).toContain('BYRÅN')
    const text = generateAttestDecisionEmailText(mail)
    expect(text).toContain('- Möbelfirman AB, faktura F-100')
    expect(text).toContain('  Kommentar: Fel belopp & datum')
    expect(text).toContain('Du får mejlet för att du registrerade fakturorna i Kundbolaget AB.')
  })

  it('says why a fallback recipient gets it', () => {
    const text = generateAttestDecisionEmailText({ ...data([inv()]), reason: 'fallback' })
    expect(text).toContain('ägare eller administratör i Kundbolaget AB')
  })
})
