import { describe, it, expect } from 'vitest'
import {
  generateReminderEmailHtml,
  generateReminderEmailText,
  generateReminderEmailSubject,
} from '../reminder-templates'
import { makeCustomer, makeInvoice, makeCompanySettings } from '@/tests/helpers'

const company = makeCompanySettings({ company_name: 'Acme AB' })
const customer = makeCustomer({ name: 'Erik Andersson', email: 'erik@example.se' })
const invoice = makeInvoice({
  invoice_number: 'F2026010',
  invoice_date: '2026-04-15',
  due_date: '2026-05-01',
  currency: 'SEK',
  total: 10_000,
})

const baseData = {
  invoice,
  customer,
  company,
  reminderLevel: 1 as const,
  daysOverdue: 25,
  actionUrl: 'https://example.com/invoice-action/abc',
}

describe('reminder email templates: surcharges', () => {
  it('renders dröjsmålsränta + påminnelseavgift in HTML when set', () => {
    const html = generateReminderEmailHtml({
      ...baseData,
      interestAmount: 86.3,
      interestRate: 0.105,
      interestFromDate: '2026-05-01',
      interestDays: 30,
      reminderFee: 60,
      totalDue: 10_146.3,
    })
    expect(html).toContain('Ursprungligt belopp:')
    expect(html).toContain('Dröjsmålsränta')
    expect(html).toContain('Påminnelseavgift:')
    expect(html).toContain('Att betala:')
    expect(html).toContain('10,5%') // rate display (sv-SE format)
    expect(html).toContain('30 dagar')
  })

  it('omits surcharge rows when both are zero', () => {
    const html = generateReminderEmailHtml({
      ...baseData,
      interestAmount: 0,
      interestRate: 0.105,
      interestFromDate: '2026-05-01',
      interestDays: 0,
      reminderFee: 0,
      totalDue: 10_000,
    })
    expect(html).not.toContain('Dröjsmålsränta')
    expect(html).not.toContain('Påminnelseavgift:')
    expect(html).toContain('Att betala:')
  })

  it('renders surcharges in plain text', () => {
    const text = generateReminderEmailText({
      ...baseData,
      interestAmount: 86.3,
      interestRate: 0.105,
      interestFromDate: '2026-05-01',
      interestDays: 30,
      reminderFee: 60,
      totalDue: 10_146.3,
    })
    expect(text).toContain('Ursprungligt belopp')
    expect(text).toContain('Dröjsmålsränta')
    expect(text).toContain('Påminnelseavgift')
    expect(text).toContain('Att betala')
  })

  it('subject includes surcharge note when surcharges apply', () => {
    const subject = generateReminderEmailSubject({
      ...baseData,
      interestAmount: 86.3,
      interestRate: 0.105,
      interestFromDate: '2026-05-01',
      interestDays: 30,
      reminderFee: 60,
      totalDue: 10_146.3,
    })
    expect(subject).toContain('F2026010')
    expect(subject).toContain('inkl. dröjsmålsränta')
  })

  it('subject is unchanged when no surcharges apply', () => {
    const subject = generateReminderEmailSubject({
      ...baseData,
      interestAmount: 0,
      interestRate: 0,
      interestFromDate: '2026-05-01',
      interestDays: 0,
      reminderFee: 0,
      totalDue: 10_000,
    })
    expect(subject).not.toContain('inkl. dröjsmålsränta')
    expect(subject).toContain('F2026010')
  })
})
