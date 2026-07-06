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

  describe('custom email texts (invoice_email_texts)', () => {
    const svCustomer = makeCustomer({ name: 'Erik Andersson', email: 'erik@example.se', language: 'sv' })
    const enCustomer = makeCustomer({ name: 'Jane Doe', email: 'jane@example.com', language: 'en' })

    const fullOverrides = makeCompanySettings({
      company_name: 'Acme AB',
      invoice_email_texts: {
        sv: {
          subject: 'Er faktura {fakturanummer} \u2013 {f\u00f6retag}',
          greeting: 'Hejsan {f\u00f6rnamn}!',
          body: 'H\u00e4r kommer m\u00e5nadens faktura.',
          signoff: 'Allt gott,',
        },
        en: {
          subject: 'Your invoice {fakturanummer}',
          greeting: 'Hello {f\u00f6rnamn}!',
          body: "Please find this month's invoice attached.",
          signoff: 'Best,',
        },
      },
    })

    it('renders sv overrides in the HTML variant, keeping structural parts', () => {
      const html = generateInvoiceEmailHtml({ invoice, customer: svCustomer, company: fullOverrides })
      expect(html).toContain('Hejsan Erik!')
      expect(html).toContain('H\u00e4r kommer m\u00e5nadens faktura.')
      expect(html).toContain('Allt gott,')
      expect(html).not.toContain('Tack f\u00f6r ditt f\u00f6rtroende')
      expect(html).not.toContain('Med v\u00e4nliga h\u00e4lsningar,')
      // Structural parts and the footer question line stay generated
      expect(html).toContain('Betalningsinformation')
      expect(html).toContain('Har du fr\u00e5gor om fakturan?')
    })

    it('renders sv overrides in the text variant', () => {
      const text = generateInvoiceEmailText({ invoice, customer: svCustomer, company: fullOverrides })
      expect(text).toContain('Hejsan Erik!')
      expect(text).toContain('H\u00e4r kommer m\u00e5nadens faktura.')
      expect(text).toContain('Allt gott,')
      expect(text).not.toContain('Med v\u00e4nliga h\u00e4lsningar,')
    })

    it('substitutes placeholders in the subject', () => {
      const subject = generateInvoiceEmailSubject({ invoice, customer: svCustomer, company: fullOverrides })
      expect(subject).toBe('Er faktura 1042 \u2013 Acme AB')
    })

    it('uses the en overrides for English customers', () => {
      const subject = generateInvoiceEmailSubject({ invoice, customer: enCustomer, company: fullOverrides })
      expect(subject).toBe('Your invoice 1042')
      const html = generateInvoiceEmailHtml({ invoice, customer: enCustomer, company: fullOverrides })
      expect(html).toContain('Hello Jane!')
    })

    it('falls back per language: sv-only overrides leave English customers on stock texts', () => {
      const svOnly = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: { sv: { body: 'H\u00e4r kommer fakturan.' } },
      })
      const html = generateInvoiceEmailHtml({ invoice, customer: enCustomer, company: svOnly })
      expect(html).toContain('Hi Jane,')
      expect(html).toContain('Thank you for your business')
      expect(generateInvoiceEmailSubject({ invoice, customer: enCustomer, company: svOnly }))
        .toBe('Invoice 1042 from Acme AB')
    })

    it('falls back per field: only overridden fields change', () => {
      const bodyOnly = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: { sv: { body: 'H\u00e4r kommer fakturan.' } },
      })
      const html = generateInvoiceEmailHtml({ invoice, customer: svCustomer, company: bodyOnly })
      expect(html).toContain('H\u00e4r kommer fakturan.')
      expect(html).toContain('Hej Erik,')
      expect(html).toContain('Med v\u00e4nliga h\u00e4lsningar,')
      expect(generateInvoiceEmailSubject({ invoice, customer: svCustomer, company: bodyOnly }))
        .toBe('Faktura 1042 fr\u00e5n Acme AB')
    })

    it('treats whitespace-only overrides as unset', () => {
      const blank = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: { sv: { body: '   ', subject: '\n' } },
      })
      const html = generateInvoiceEmailHtml({ invoice, customer: svCustomer, company: blank })
      expect(html).toContain('Tack f\u00f6r ditt f\u00f6rtroende')
      expect(generateInvoiceEmailSubject({ invoice, customer: svCustomer, company: blank }))
        .toBe('Faktura 1042 fr\u00e5n Acme AB')
    })

    it('substitutes all six placeholders with per-language formatting', () => {
      const allPlaceholders = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: {
          sv: { body: '{fakturanummer} {kundnamn} {f\u00f6rnamn} {f\u00f6retag} {f\u00f6rfallodatum} {belopp}' },
          en: { body: '{fakturanummer} {kundnamn} {f\u00f6rnamn} {f\u00f6retag} {f\u00f6rfallodatum} {belopp}' },
        },
      })
      const svText = generateInvoiceEmailText({ invoice, customer: svCustomer, company: allPlaceholders })
      expect(svText).toContain('1042 Erik Andersson Erik Acme AB 2026-06-21')
      expect(svText).toMatch(/12[\s\u00a0]500,00 SEK/)

      const enText = generateInvoiceEmailText({ invoice, customer: enCustomer, company: allPlaceholders })
      expect(enText).toContain('1042 Jane Doe Jane Acme AB 2026-06-21 12,500.00 SEK')
    })

    it('leaves unknown placeholders literal', () => {
      const typo = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: { sv: { subject: 'Faktura {fakturanumer}', body: 'Se {bilaga}' } },
      })
      expect(generateInvoiceEmailSubject({ invoice, customer: svCustomer, company: typo }))
        .toBe('Faktura {fakturanumer}')
      const text = generateInvoiceEmailText({ invoice, customer: svCustomer, company: typo })
      expect(text).toContain('Se {bilaga}')
    })

    it('is forgiving about placeholder case and spacing', () => {
      const spaced = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: { sv: { greeting: 'Hej { F\u00f6rnamn }!' } },
      })
      const text = generateInvoiceEmailText({ invoice, customer: svCustomer, company: spaced })
      expect(text).toContain('Hej Erik!')
    })

    it('escapes HTML in custom texts but keeps the text variant verbatim', () => {
      const xss = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: { sv: { body: '<script>alert(1)</script> & "quoted"' } },
      })
      const html = generateInvoiceEmailHtml({ invoice, customer: svCustomer, company: xss })
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;')
      const text = generateInvoiceEmailText({ invoice, customer: svCustomer, company: xss })
      expect(text).toContain('<script>alert(1)</script> & "quoted"')
    })

    it('escapes substituted placeholder values in the HTML variant', () => {
      const trickyCustomer = makeCustomer({ name: 'Bj\u00f6rk & S\u00f6ner <AB>', language: 'sv' })
      const withName = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: { sv: { body: 'Till {kundnamn}.' } },
      })
      const html = generateInvoiceEmailHtml({ invoice, customer: trickyCustomer, company: withName })
      expect(html).toContain('Till Bj\u00f6rk &amp; S\u00f6ner &lt;AB&gt;.')
      const text = generateInvoiceEmailText({ invoice, customer: trickyCustomer, company: withName })
      expect(text).toContain('Till Bj\u00f6rk & S\u00f6ner <AB>.')
    })

    it('converts newlines in the body to <br> in HTML and keeps them in text', () => {
      const multiline = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: { sv: { body: 'Rad 1\nRad 2' } },
      })
      const html = generateInvoiceEmailHtml({ invoice, customer: svCustomer, company: multiline })
      expect(html).toContain('Rad 1<br>Rad 2')
      const text = generateInvoiceEmailText({ invoice, customer: svCustomer, company: multiline })
      expect(text).toContain('Rad 1\nRad 2')
    })

    it('flattens newlines in a custom subject (header injection)', () => {
      const inject = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: {
          sv: { subject: 'Faktura {fakturanummer}\r\nBcc: attacker@example.com' },
        },
      })
      const subject = generateInvoiceEmailSubject({ invoice, customer: svCustomer, company: inject })
      expect(subject).toBe('Faktura 1042 Bcc: attacker@example.com')
      expect(subject).not.toMatch(/[\r\n]/)
    })

    it('does not re-substitute placeholder-like values (single pass)', () => {
      const weirdCustomer = makeCustomer({ name: '{belopp} AB', language: 'sv' })
      const greetByName = makeCompanySettings({
        company_name: 'Acme AB',
        invoice_email_texts: { sv: { greeting: 'Hej {kundnamn}!' } },
      })
      const text = generateInvoiceEmailText({ invoice, customer: weirdCustomer, company: greetByName })
      expect(text).toContain('Hej {belopp} AB!')
    })

    it('ignores overrides on credit notes', () => {
      const creditInvoice = makeInvoice({
        invoice_number: '1043',
        due_date: '2026-05-22',
        currency: 'SEK',
        total: -5000,
        credited_invoice_id: 'inv-orig',
      })
      const html = generateInvoiceEmailHtml({ invoice: creditInvoice, customer: svCustomer, company: fullOverrides })
      expect(html).toContain('Bifogat hittar du en kreditfaktura')
      expect(html).not.toContain('H\u00e4r kommer m\u00e5nadens faktura.')
      expect(generateInvoiceEmailSubject({ invoice: creditInvoice, customer: svCustomer, company: fullOverrides }))
        .toBe('Kreditfaktura 1043 fr\u00e5n Acme AB')
    })

    it('ignores overrides on proforma invoices', () => {
      const proforma = makeInvoice({ invoice_number: '1044', document_type: 'proforma' })
      const html = generateInvoiceEmailHtml({ invoice: proforma, customer: svCustomer, company: fullOverrides })
      expect(html).toContain('Tack f\u00f6r ditt f\u00f6rtroende')
      expect(html).not.toContain('H\u00e4r kommer m\u00e5nadens faktura.')
      expect(generateInvoiceEmailSubject({ invoice: proforma, customer: svCustomer, company: fullOverrides }))
        .toBe('Proformafaktura 1044 fr\u00e5n Acme AB')
    })

    it('ignores overrides on delivery notes', () => {
      const deliveryNote = makeInvoice({ invoice_number: '1045', document_type: 'delivery_note' })
      const html = generateInvoiceEmailHtml({ invoice: deliveryNote, customer: svCustomer, company: fullOverrides })
      expect(html).not.toContain('H\u00e4r kommer m\u00e5nadens faktura.')
      expect(generateInvoiceEmailSubject({ invoice: deliveryNote, customer: svCustomer, company: fullOverrides }))
        .toBe('F\u00f6ljesedel 1045 fr\u00e5n Acme AB')
    })
  })
})
