import { describe, it, expect } from 'vitest'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { renderReminderEmail, REMINDER_EMAIL_DEFAULT_TEXTS, type ReminderEmailData } from '../templates'

function data(overrides: Partial<ReminderEmailData> = {}): ReminderEmailData {
  return {
    level: 1,
    invoice: makeInvoice({ invoice_number: 'F-1042', invoice_date: '2026-11-02', due_date: '2026-12-02', status: 'sent', total: 12500 }),
    customer: makeCustomer({ name: 'Kund AB', contact_person: null }),
    company: makeCompanySettings({ company_name: 'Säljaren AB', bankgiro: '123-4567', org_number: '5566778899' }),
    amount: 2500,
    remaining: 2500,
    payBy: '2027-01-24',
    overdueDays: 15,
    actionUrl: 'https://app.accounted.se/invoice-action/tok123',
    replyTo: 'faktura@saljaren.se',
    ...overrides,
  }
}

describe('renderReminderEmail', () => {
  it('asks for what is left to pay, not the original total', () => {
    const mail = renderReminderEmail(data())
    expect(mail.subject).toBe('Vänlig påminnelse: Faktura F-1042 - 2 500,00 SEK')
    expect(mail.text).toContain('Att betala: 2 500,00 SEK')
    expect(mail.text).not.toContain('12 500,00')
  })

  it('shows what the invoice asked for and what came in after a part payment', () => {
    const mail = renderReminderEmail(data({ amount: 12500, remaining: 2500 }))
    // Currency formatting puts a no-break space in the amounts.
    expect(mail.subject).toMatch(/- 2\s500,00\sSEK$/)
    expect(mail.text).toMatch(/Fakturabelopp: 12\s500,00\sSEK\nBetalt: 10\s000,00\sSEK\nAtt betala: 2\s500,00\sSEK/)
    expect(renderReminderEmail(data()).text).not.toContain('Betalt:')
  })

  it('asks for payment by a date in the final reminder', () => {
    expect(renderReminderEmail(data({ level: 3 })).text).toContain('ber dig betala senast den 2027-01-24.')
    expect(renderReminderEmail(data({ level: 3, customer: makeCustomer({ language: 'en' }) })).text).toContain('ask you to pay by 2027-01-24.')
  })

  it('words each level, and level 3 is a final reminder with no inkasso threat', () => {
    expect(renderReminderEmail(data({ level: 2 })).subject).toMatch(/^Andra påminnelsen: Faktura F-1042/)
    const final = renderReminderEmail(data({ level: 3 }))
    expect(final.subject).toMatch(/^Slutlig påminnelse: Faktura F-1042/)
    expect(final.text.toLowerCase()).not.toContain('inkasso')
    expect(final.html.toLowerCase()).not.toContain('inkasso')
  })

  it('never mentions a fee or interest', () => {
    for (const level of [1, 2, 3] as const) {
      const mail = renderReminderEmail(data({ level }))
      expect(mail.text).not.toMatch(/påminnelseavgift|dröjsmålsränta|ränta/i)
    }
  })

  it('shows the invoice payment rows, the answer link and the reply line', () => {
    const mail = renderReminderEmail(data())
    expect(mail.text).toContain('Betalningsinformation:')
    expect(mail.text).toContain('123-4567')
    expect(mail.html).toContain('href="https://app.accounted.se/invoice-action/tok123"')
    expect(mail.text).toContain('Svara direkt på det här mejlet.')
  })

  it('leaves out the answer link and the reply line when there is none', () => {
    const mail = renderReminderEmail(data({ actionUrl: null, replyTo: null }))
    expect(mail.html).not.toContain('invoice-action')
    expect(mail.text).not.toContain('Svara direkt')
  })

  it('writes English to an English-speaking customer', () => {
    const mail = renderReminderEmail(data({ customer: makeCustomer({ language: 'en' }) }))
    expect(mail.subject).toBe('Friendly reminder: Invoice F-1042 - 2,500.00 SEK')
    expect(mail.html).toContain('<html lang="en">')
  })

  it("uses the company's own Swedish text per level, with placeholders, escaped", () => {
    const company = makeCompanySettings({
      company_name: 'Säljaren AB',
      reminder_text_overrides: { level_1: { subject: 'Påminnelse {fakturanummer}', body: 'Hej <b>{kundnamn}</b>, {dagar} dagar sedan.' } },
    })
    const mail = renderReminderEmail(data({ company }))
    expect(mail.subject).toBe('Påminnelse F-1042')
    expect(mail.html).toContain('Hej &lt;b&gt;Kund AB&lt;/b&gt;, 15 dagar sedan.')
    // Level 2 keeps the stock text.
    expect(renderReminderEmail(data({ company, level: 2 })).subject).toMatch(/^Andra påminnelsen/)
    // English mail keeps the stock English text.
    expect(renderReminderEmail(data({ company, customer: makeCustomer({ language: 'en' }) })).subject).toMatch(/^Friendly reminder/)
  })

  it('escapes a customer name and keeps the subject on one line', () => {
    const mail = renderReminderEmail(
      data({
        company: makeCompanySettings({ reminder_text_overrides: { level_1: { subject: 'Rad ett\nRad två {kundnamn}' } } }),
        customer: makeCustomer({ name: '<script>x</script>' }),
      }),
    )
    expect(mail.subject).toBe('Rad ett Rad två <script>x</script>')
    expect(mail.html).not.toContain('<script>')
  })

  it('has a stock text for every level in both languages', () => {
    for (const lang of ['sv', 'en'] as const) {
      for (const level of [1, 2, 3] as const) {
        expect(REMINDER_EMAIL_DEFAULT_TEXTS[lang][level].subject).toContain('{fakturanummer}')
        expect(REMINDER_EMAIL_DEFAULT_TEXTS[lang][level].body).toContain('{förfallodatum}')
      }
    }
  })
})
