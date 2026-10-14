import { describe, expect, it } from 'vitest'
import {
  generatePaymentSigningRequestEmailHtml,
  generatePaymentSigningRequestEmailSubject,
  generatePaymentSigningRequestEmailText,
} from '../payment-signing-request-templates'
import { formatSigningLinkExpiry } from '@/lib/payments/orders/signing-link-expiry'

const data = {
  companyName: 'Bolaget & Co AB',
  requester: 'Byrån AB',
  orderCount: 3,
  totalAmount: 12500.5,
  currency: 'SEK',
  signingUrl: 'https://app.accounted.se/betala/abc',
  expiresAt: '2026-10-17T12:05:00.000Z',
  note: 'Leverantörerna för oktober <3',
  appName: 'Accounted',
}

describe('payment_signing_request mail', () => {
  it('says who asks, which company, how many payments and how much, the link and when it runs out', () => {
    expect(generatePaymentSigningRequestEmailSubject(data)).toBe('Signera 3 betalningar från Bolaget & Co AB med BankID')
    const text = generatePaymentSigningRequestEmailText(data)
    expect(text).toContain('Byrån AB har förberett 3 betalningar från Bolaget & Co AB på totalt')
    expect(text).toMatch(/12\s500,5\s*kr/)
    expect(text).toContain('ber dig som firmatecknare att signera med BankID')
    expect(text).toContain('Leverantörerna för oktober <3')
    expect(text).toContain('Granska och signera: https://app.accounted.se/betala/abc')
    expect(text).toContain('Inget betalas förrän du har signerat')
    expect(text).toContain('gäller till 17 oktober 2026 kl. 14:05')
    expect(text).toContain('Open Payments Europe AB')
  })

  it('speaks of one payment in the singular', () => {
    expect(generatePaymentSigningRequestEmailSubject({ ...data, orderCount: 1 })).toBe('Signera en betalning från Bolaget & Co AB med BankID')
    expect(generatePaymentSigningRequestEmailText({ ...data, orderCount: 1 })).toContain('har förberett en betalning från')
  })

  it('escapes names and the note in the HTML and shows the URL in clear text beside the button', () => {
    const html = generatePaymentSigningRequestEmailHtml(data)
    expect(html).toContain('Bolaget &amp; Co AB')
    expect(html).not.toContain('Bolaget & Co AB')
    expect(html).toContain('Leverantörerna för oktober &lt;3')
    expect(html).toContain('href="https://app.accounted.se/betala/abc"')
    expect(html).toContain('Länken går till:')
  })

  it('leaves the note out when there is none', () => {
    const plain = { ...data, note: null }
    expect(generatePaymentSigningRequestEmailText(plain)).not.toContain('oktober <3')
    expect(generatePaymentSigningRequestEmailHtml(plain)).not.toContain('border-left')
  })

  it('tells the expiry in Stockholm time', () => {
    expect(formatSigningLinkExpiry('2026-01-10T07:30:00.000Z')).toBe('10 januari 2026 kl. 08:30')
  })

  it('never uses an em or en dash', () => {
    for (const out of [generatePaymentSigningRequestEmailSubject(data), generatePaymentSigningRequestEmailText(data), generatePaymentSigningRequestEmailHtml(data)]) {
      expect(out).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
