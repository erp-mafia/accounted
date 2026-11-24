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

  it('tells a company whose bank the new provider does not reach when its feed ends and how the file import goes on', () => {
    const uncovered: BankSwitchEmailData = { ...announcement, kind: 'uncovered', bankNames: ['Wise'], daysLeft: 5, switchUrl: 'https://app.gnubok.se/import?mode=bank', byraManaged: true }
    const subject = generateBankSwitchEmailSubject(uncovered)
    const html = generateBankSwitchEmailHtml(uncovered)
    const text = generateBankSwitchEmailText(uncovered)
    expect(subject).toBe('Kopplingen till Wise slutar hämta transaktioner 9 nov. 2026 - Exempelbolaget AB')
    expect(text).toContain('den nya leverantören når inte banken än. Efter 9 nov. 2026 hämtas inga nya transaktioner därifrån.')
    expect(text).toContain('ladda ner kontoutdraget från Wise som fil (CSV eller camt) och importera det under Importera, Bankfil.')
    expect(text).toContain('Hämtas till: 9 nov. 2026')
    expect(text).toContain('Importera bankfil: https://app.gnubok.se/import?mode=bank')
    expect(html).toContain('href="https://app.gnubok.se/import?mode=bank"')
    expect(html).toContain('Hämtas till')
    // Nothing to switch and no BankID to sign: no switch wording, no byrå line.
    expect(text).not.toMatch(/Byt till ny koppling|BankID/)
  })

  it('adds the banks the new provider does not reach to a switch mail, as the file import after the deadline', () => {
    const text = generateBankSwitchEmailText({ ...announcement, uncoveredBankNames: ['PayPal', 'Wise'] })
    expect(text).toContain('PayPal och Wise nås inte av den nya leverantören: efter 9 nov. 2026 importerar du kontoutdrag därifrån som fil under Importera, Bankfil.')
    expect(generateBankSwitchEmailText({ ...stopped, uncoveredBankNames: ['PayPal'] })).toContain(
      'PayPal nås inte av den nya leverantören: importera kontoutdrag därifrån som fil under Importera, Bankfil.',
    )
    expect(generateBankSwitchEmailText(announcement)).not.toMatch(/nås inte/)
  })

  it('leaves the company row out when the name is unknown', () => {
    const data = { ...announcement, companyName: '' }
    expect(generateBankSwitchEmailHtml(data)).not.toContain('Företag')
    expect(generateBankSwitchEmailSubject(data)).toBe('Bankkopplingen till Swedbank byter leverantör')
  })
})
