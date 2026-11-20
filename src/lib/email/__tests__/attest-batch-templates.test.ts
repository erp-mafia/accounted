import { describe, expect, it } from 'vitest'
import {
  generateAttestBatchEmailHtml,
  generateAttestBatchEmailSubject,
  generateAttestBatchEmailText,
  type AttestBatchEmailData,
} from '../attest-batch-templates'
import {
  generateAttestNoticeEmailHtml,
  generateAttestNoticeEmailSubject,
  generateAttestNoticeEmailText,
  type AttestNoticeEmailData,
} from '../attest-notice-templates'

const invoice = (supplierName: string, total: number, dueDate = '2026-11-05') => ({
  supplierName,
  invoiceNumber: '4816',
  arrivalNumber: 7,
  total,
  currency: 'SEK',
  dueDate,
})

const batch = (overrides: Partial<AttestBatchEmailData> = {}): AttestBatchEmailData => ({
  kind: 'request',
  companyName: 'Kundbolaget AB',
  invoices: [invoice('Möbelfirman AB', 29625), invoice('Konsultbolaget <AB>', 11250, '2026-11-19')],
  registeredBy: 'Alex',
  url: 'https://byra.accounted.se/attest/lista/token',
  appName: 'Byrån',
  ...overrides,
})

describe('the batched attest mail', () => {
  it('names one invoice by supplier and amount, several by count, and a reminder as one', () => {
    const one = batch({ invoices: [invoice('Möbelfirman AB', 29625)] })
    expect(generateAttestBatchEmailSubject(one)).toMatch(/^Attestera Möbelfirman AB 29\s625\skr$/)
    expect(generateAttestBatchEmailSubject(batch())).toBe('2 leverantörsfakturor väntar på din attest')
    expect(generateAttestBatchEmailSubject(batch({ kind: 'reminder' }))).toBe('Påminnelse: 2 leverantörsfakturor väntar på din attest')
    expect(generateAttestBatchEmailSubject({ ...one, kind: 'reminder' })).toMatch(/^Påminnelse: attestera Möbelfirman AB .+, förfaller 2026-11-05$/)
  })

  it('lists every invoice, escapes what suppliers write, and offers one button that decides nothing by itself', () => {
    const html = generateAttestBatchEmailHtml(batch())
    expect(html).toContain('Möbelfirman AB')
    expect(html).toContain('Konsultbolaget &lt;AB&gt;')
    expect(html).not.toContain('Konsultbolaget <AB>')
    expect(html).toContain('Granska och attestera')
    expect(html).toContain('href="https://byra.accounted.se/attest/lista/token"')
    expect(html).not.toMatch(/beslut=/)
    expect(html).toContain('BYRÅN')
    const text = generateAttestBatchEmailText(batch())
    expect(text).toContain('2 leverantörsfakturor till Kundbolaget AB väntar på din attest. Alex har registrerat dem.')
    expect(text).toContain('Granska och attestera: https://byra.accounted.se/attest/lista/token')
    expect(`${html}${text}`).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('the registrant notice', () => {
  const notice = (overrides: Partial<AttestNoticeEmailData> = {}): AttestNoticeEmailData => ({
    kind: 'overdue',
    companyName: 'Kundbolaget AB',
    invoices: [invoice('Möbelfirman AB', 29625, '2026-09-15'), invoice('Möbelfirman AB', 24375, '2026-09-15')],
    url: 'https://byra.accounted.se/supplier-invoices?tab=registered',
    reason: 'registrant',
    appName: 'Byrån',
    ...overrides,
  })

  it('says the due date passed without attest, or that nobody can attest, and what to do', () => {
    expect(generateAttestNoticeEmailSubject(notice())).toBe('2 leverantörsfakturor har passerat förfallodagen utan attest')
    expect(generateAttestNoticeEmailSubject(notice({ kind: 'blocked', invoices: [invoice('Möbelfirman AB', 29625)] }))).toMatch(/^Ingen kan attestera Möbelfirman AB /)
    const blocked = generateAttestNoticeEmailText(notice({ kind: 'blocked', url: 'https://byra.accounted.se/settings/attest' }))
    expect(blocked).toContain('Den som registrerar får också attestera')
    expect(blocked).toContain('Öppna attestreglerna: https://byra.accounted.se/settings/attest')
    const html = generateAttestNoticeEmailHtml(notice({ reason: 'fallback' }))
    expect(html).toContain('ägare eller administratör')
    expect(html).toContain('Öppna leverantörsfakturorna')
    expect(`${html}${blocked}`).not.toMatch(/[\u2013\u2014]/)
  })
})
