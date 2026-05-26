import { describe, it, expect } from 'vitest'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '../invoice-templates'
import { makeCustomer, makeInvoice, makeCompanySettings } from '@/tests/helpers'

const company = makeCompanySettings({
  company_name: 'Acme AB',
  bank_name: 'SEB',
  clearing_number: '5000',
  account_number: '1234567',
  iban: 'SE45 5000 0000 0583 9825 7466',
  bic: 'ESSESESS',
  org_number: '556677-8899',
  vat_number: 'SE556677889901',
  f_skatt: true,
})

const invoice = makeInvoice({
  invoice_number: '1042',
  invoice_date: '2026-05-22',
  due_date: '2026-06-21',
  currency: 'SEK',
  total: 12500,
})

describe('invoice email templates', () => {
  describe('Swedish customer (default)', () => {
    const customer = makeCustomer({ name: 'Erik Andersson', email: 'erik@example.se', language: 'sv' })
    const data = { invoice, customer, company }

    it('uses Swedish chrome in HTML', () => {
      const html = generateInvoiceEmailHtml(data)
      expect(html).toContain('<html lang="sv">')
      expect(html).toContain('Faktura från Acme AB')
      expect(html).toContain('Att betala:')
      expect(html).toContain('Betalningsinformation')
      expect(html).toContain('Hej Erik,')
      expect(html).toContain('Med vänliga hälsningar,')
      expect(html).toContain('Innehar F-skattsedel')
    })

    it('renders the total with explicit SEK code, not "kr"', () => {
      const html = generateInvoiceEmailHtml(data)
      // sv-SE digit grouping: "12 500,00 SEK"
      expect(html).toMatch(/12[\s\u00a0]500,00 SEK/)
      expect(html).not.toContain('kr')
    })

    it('uses Swedish subject', () => {
      expect(generateInvoiceEmailSubject(data)).toBe('Faktura 1042 från Acme AB')
    })

    it('uses Swedish plain text body', () => {
      const text = generateInvoiceEmailText(data)
      expect(text).toContain('Hej Erik,')
      expect(text).toContain('Att betala:')
      expect(text).toContain('Förfallodatum:')
      expect(text).not.toContain('kr')
    })
  })

  describe('English customer', () => {
    const customer = makeCustomer({ name: 'Jane Doe', email: 'jane@example.com', language: 'en' })
    const data = { invoice, customer, company }

    it('uses English chrome in HTML', () => {
      const html = generateInvoiceEmailHtml(data)
      expect(html).toContain('<html lang="en">')
      expect(html).toContain('Invoice from Acme AB')
      expect(html).toContain('Total due:')
      expect(html).toContain('Payment information')
      expect(html).toContain('Hi Jane,')
      expect(html).toContain('Kind regards,')
      // F-skatt is statutory and stays Swedish in both locales.
      expect(html).toContain('Innehar F-skattsedel')
    })

    it('renders the total with explicit SEK code in English digit grouping', () => {
      const html = generateInvoiceEmailHtml(data)
      // en-US digit grouping: "12,500.00 SEK"
      expect(html).toContain('12,500.00 SEK')
      expect(html).not.toContain('kr')
    })

    it('uses English subject', () => {
      expect(generateInvoiceEmailSubject(data)).toBe('Invoice 1042 from Acme AB')
    })

    it('uses English plain text body', () => {
      const text = generateInvoiceEmailText(data)
      expect(text).toContain('Hi Jane,')
      expect(text).toContain('Total due:')
      expect(text).toContain('Due date:')
      expect(text).toContain('Thank you for your business')
      expect(text).not.toContain('kr')
    })
  })

  describe('credit note', () => {
    const creditInvoice = makeInvoice({
      invoice_number: '1043',
      invoice_date: '2026-05-22',
      due_date: '2026-05-22',
      currency: 'SEK',
      total: -5000,
      credited_invoice_id: 'inv-orig',
    })

    it('translates the credit-note body in English', () => {
      const customer = makeCustomer({ language: 'en' })
      const html = generateInvoiceEmailHtml({ invoice: creditInvoice, customer, company })
      expect(html).toContain('Credit note')
      expect(html).toContain('Attached you will find a credit note')
    })

    it('keeps the credit-note body in Swedish for sv customers', () => {
      const customer = makeCustomer({ language: 'sv' })
      const html = generateInvoiceEmailHtml({ invoice: creditInvoice, customer, company })
      expect(html).toContain('Kreditfaktura')
      expect(html).toContain('Bifogat hittar du en kreditfaktura')
    })
  })

  describe('non-SEK currency', () => {
    const eurInvoice = makeInvoice({
      invoice_number: '1044',
      currency: 'EUR',
      total: 1000,
    })

    it('writes EUR code with the chosen locale grouping', () => {
      const enCustomer = makeCustomer({ language: 'en' })
      const enHtml = generateInvoiceEmailHtml({ invoice: eurInvoice, customer: enCustomer, company })
      expect(enHtml).toContain('1,000.00 EUR')

      const svCustomer = makeCustomer({ language: 'sv' })
      const svHtml = generateInvoiceEmailHtml({ invoice: eurInvoice, customer: svCustomer, company })
      expect(svHtml).toMatch(/1[\s\u00a0]000,00 EUR/)
    })
  })
})
