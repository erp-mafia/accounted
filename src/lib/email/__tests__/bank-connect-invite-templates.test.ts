import { describe, expect, it } from 'vitest'
import {
  generateBankConnectInviteEmailHtml,
  generateBankConnectInviteEmailSubject,
  generateBankConnectInviteEmailText,
} from '../bank-connect-invite-templates'

const data = {
  companyName: 'Bolaget & Co AB',
  requester: 'Byrån AB',
  bankName: 'Swedbank',
  inviteUrl: 'https://app.accounted.se/koppla/abc',
  offerPayments: true,
  appName: 'Accounted',
}

describe('bank_connect_invite mail', () => {
  it('says who asks, which company and bank, what to have ready, the link and the 7 days', () => {
    expect(generateBankConnectInviteEmailSubject(data)).toBe('Koppla banken för Bolaget & Co AB med BankID')
    const text = generateBankConnectInviteEmailText(data)
    expect(text).toContain('Byrån AB ber dig som firmatecknare')
    expect(text).toContain('Bolaget & Co ABs bankkonto hos Swedbank till Accounted')
    expect(text).toContain('BankID, och behörighet till företagets konton hos banken')
    expect(text).toContain('verifiera företaget för betalningar')
    expect(text).toContain('Koppla banken: https://app.accounted.se/koppla/abc')
    expect(text).toContain('giltig i 7 dagar')
    expect(text).toContain('Open Payments Europe AB')
  })

  it('escapes names in the HTML and shows the URL in clear text beside the button', () => {
    const html = generateBankConnectInviteEmailHtml(data)
    expect(html).toContain('Bolaget &amp; Co AB')
    expect(html).not.toContain('Bolaget & Co AB')
    expect(html).toContain('href="https://app.accounted.se/koppla/abc"')
    expect(html).toContain('Länken går till:')
    expect(html).toContain('hos Swedbank')
  })

  it('leaves the bank and the payments offer out when the link has neither', () => {
    const plain = { ...data, bankName: null, offerPayments: false }
    const text = generateBankConnectInviteEmailText(plain)
    expect(text).toContain('Bolaget & Co ABs bankkonto till Accounted')
    expect(text).not.toContain('hos Swedbank')
    expect(text).toContain('välj bank, signera med BankID')
    expect(text).not.toContain('betalningar')
    expect(generateBankConnectInviteEmailHtml(plain)).not.toContain('betalningar')
  })

  it('never uses an em or en dash', () => {
    for (const out of [generateBankConnectInviteEmailSubject(data), generateBankConnectInviteEmailText(data), generateBankConnectInviteEmailHtml(data)]) {
      expect(out).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
