import { describe, expect, it } from 'vitest'
import {
  generatePaymentFailedEmailHtml,
  generatePaymentFailedEmailSubject,
  generatePaymentFailedEmailText,
  type PaymentFailedEmailData,
} from '../payment-failed-templates'

const derome = {
  payee: 'Derome Bygg AB',
  invoiceLabel: 'faktura 1042',
  amount: 12500.5,
  currency: 'SEK',
  executionDate: '2026-10-20',
  reason: 'Användaren saknar behörighet att betala från kontot. Ändra behörigheterna i internetbanken.',
}

const data: PaymentFailedEmailData = {
  companyName: 'Bygg & Co AB',
  payments: [derome],
  paymentsUrl: 'https://app.accounted.se/payments',
  appName: 'Accounted',
}

describe('payment_failed mail', () => {
  it('names the payee, what it was, the bank reason, what to do and the way to Betalningar', () => {
    expect(generatePaymentFailedEmailSubject(data)).toBe('Betalningen till Derome Bygg AB gick inte igenom')
    const text = generatePaymentFailedEmailText(data)
    expect(text).toContain('Banken har inte genomfört den här betalningen från Bygg & Co AB, så mottagaren har inte fått pengarna.')
    expect(text).toMatch(/- Derome Bygg AB, 12\s500,50\s*kr, faktura 1042, betalningsdag 2026-10-20/)
    expect(text).toContain(derome.reason)
    expect(text).toContain('Åtgärda orsaken och gör en ny betalning, i Accounted eller i internetbanken.')
    expect(text).toContain('Öppna Betalningar: https://app.accounted.se/payments')
    expect(text).toContain('för att du skapade, godkände eller signerade betalningen')
  })

  it('speaks of several payments in the plural, with the company in the subject', () => {
    const several = { ...data, payments: [derome, { ...derome, payee: 'Skatteverket', invoiceLabel: null, amount: 800 }] }
    expect(generatePaymentFailedEmailSubject(several)).toBe('2 betalningar från Bygg & Co AB gick inte igenom')
    const text = generatePaymentFailedEmailText(several)
    expect(text).toContain('de här betalningarna från Bygg & Co AB, så mottagarna har inte fått pengarna')
    expect(text).toMatch(/- Skatteverket, 800\s*kr, betalningsdag 2026-10-20/)
  })

  it('escapes names in the HTML, keeps the subject on one line and shows the URL beside the button', () => {
    const hostile = { ...data, companyName: 'A<b>\nB', payments: [{ ...derome, payee: '<script>x</script>' }] }
    const html = generatePaymentFailedEmailHtml(hostile)
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).toContain('href="https://app.accounted.se/payments"')
    expect(html).toContain('Länken går till: <a href="https://app.accounted.se/payments"')
    expect(generatePaymentFailedEmailSubject({ ...hostile, payments: [derome, derome] })).toBe('2 betalningar från A<b> B gick inte igenom')
  })
})
