import { describe, expect, it } from 'vitest'
import { getBranding } from '@/lib/branding/service'
import {
  generateBankSwitchEmailHtml,
  generateBankSwitchEmailSubject,
  generateBankSwitchEmailText,
  joinBankNames,
  type BankSwitchEmailData,
} from '@/lib/email/bank-switch-templates'

const announcement: BankSwitchEmailData = {
  kind: 'announcement',
  bankNames: ['Swedbank'],
  deadline: '2026-11-09',
  daysLeft: 28,
  switchUrl: 'https://app.gnubok.se/settings/connections?bank_connect_switch=11111111-1111-4111-8111-111111111111',
  companyName: 'Exempelbolaget AB',
  byraManaged: false,
}
const reminder: BankSwitchEmailData = { ...announcement, kind: 'reminder', daysLeft: 3 }
const stopped: BankSwitchEmailData = { ...announcement, kind: 'reminder', daysLeft: -1 }

describe('joinBankNames', () => {
  it('reads as Swedish', () => {
    expect(joinBankNames(['Swedbank'])).toBe('Swedbank')
    expect(joinBankNames(['Swedbank', 'SEB'])).toBe('Swedbank och SEB')
    expect(joinBankNames(['Swedbank', 'SEB', 'Nordea'])).toBe('Swedbank, SEB och Nordea')
    expect(joinBankNames([' ', ''])).toBe('banken')
  })
})

describe('bank switch email templates', () => {
  it('announces the switch with the deadline, the button to the deep link and the history line', () => {
    const subject = generateBankSwitchEmailSubject(announcement)
    const html = generateBankSwitchEmailHtml(announcement)
    const text = generateBankSwitchEmailText(announcement)
    expect(subject).toBe('Bankkopplingen till Swedbank byter leverantör - Exempelbolaget AB')
    expect(html).toContain('9 nov. 2026')
    expect(html).toContain(`href="${announcement.switchUrl}"`)
    expect(html).toContain('Byt bankkoppling')
    expect(html).toContain('Historiken behålls')
    expect(html).toContain(`Knappen leder till ${announcement.switchUrl}.`)
    expect(text).toContain(`Byt bankkoppling: ${announcement.switchUrl}`)
    expect(text).toContain('Senast: 9 nov. 2026')
    expect(text).toContain('Historiken behålls')
    expect(html).not.toContain('inte av byrån')
  })

  it('reminds with the days left, and after the deadline says the feed has stopped', () => {
    expect(generateBankSwitchEmailSubject(reminder)).toBe('Påminnelse: byt bankkopplingen till Swedbank senast 9 nov. 2026 - Exempelbolaget AB')
    expect(generateBankSwitchEmailText(reminder)).toContain('Det är 3 dagar kvar')
    expect(generateBankSwitchEmailSubject({ ...reminder, daysLeft: 1 })).toContain('Påminnelse')
    expect(generateBankSwitchEmailText({ ...reminder, daysLeft: 0 })).toContain('i dag är sista dagen')
    expect(generateBankSwitchEmailSubject(stopped)).toBe('Hämtningen från Swedbank har stoppats - Exempelbolaget AB')
    expect(generateBankSwitchEmailText(stopped)).toContain('hämtas ikapp')
  })

  it('says on the day the feed stops that from today the old connection fetches nothing, and still points at the switch', () => {
    const sunset: BankSwitchEmailData = { ...announcement, kind: 'sunset', daysLeft: -1 }
    expect(generateBankSwitchEmailSubject(sunset)).toBe('Från i dag hämtar den gamla kopplingen inga transaktioner - Exempelbolaget AB')
    const text = generateBankSwitchEmailText(sunset)
    expect(text).toContain('Den tidigare leverantören av bankkopplingen till Swedbank har stängts')
    expect(text).toContain('hämtas ikapp')
    expect(text).toContain(`Byt bankkoppling: ${announcement.switchUrl}`)
    expect(generateBankSwitchEmailHtml(sunset)).toContain('Historiken behålls')
  })

  it('tells a byrå-managed company that its own BankID signs the switch', () => {
    const data = { ...announcement, byraManaged: true }
    expect(generateBankSwitchEmailHtml(data)).toContain('inte av byrån')
    expect(generateBankSwitchEmailText(data)).toContain('inte av byrån')
  })

  it('names every bank and the plural button when several wait', () => {
    const data: BankSwitchEmailData = { ...announcement, bankNames: ['Swedbank', 'SEB'], switchUrl: 'https://app.gnubok.se/settings/connections' }
    expect(generateBankSwitchEmailSubject(data)).toBe('Bankkopplingarna till Swedbank och SEB byter leverantör - Exempelbolaget AB')
    expect(generateBankSwitchEmailHtml(data)).toContain('Byt bankkopplingarna')
    expect(generateBankSwitchEmailText(data)).toContain('per bank')
  })

  it('signs off as the app, escapes user text, and uses no alarm colors', () => {
    const { appName } = getBranding()
    const data = { ...announcement, companyName: 'Fisk & <Co> AB', bankNames: ['Swed<bank>'] }
    const html = generateBankSwitchEmailHtml(data)
    expect(html).toContain(`<strong>${appName}</strong>`)
    expect(html).toContain('Fisk &amp; &lt;Co&gt; AB')
    expect(html).toContain('Swed&lt;bank&gt;')
    expect(html).not.toContain('<Co>')
    expect(html).not.toMatch(/#dc2626|#ea580c|#ef4444|#b91c1c/i)
  })

  it('leaves the company row out when the name is unknown', () => {
    const data = { ...announcement, companyName: '' }
    expect(generateBankSwitchEmailHtml(data)).not.toContain('Företag')
    expect(generateBankSwitchEmailSubject(data)).toBe('Bankkopplingen till Swedbank byter leverantör')
  })
})
