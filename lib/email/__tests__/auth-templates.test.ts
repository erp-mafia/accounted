import { describe, it, expect } from 'vitest'
import { buildAuthEmail } from '../auth-templates'

const URL_EXAMPLE = 'https://app.siffra.se/auth/callback?token_hash=abc&type=recovery'
// In HTML the URL lands in an attribute and is entity-escaped.
const URL_EXAMPLE_HTML = URL_EXAMPLE.replace(/&/g, '&amp;')

describe('buildAuthEmail', () => {
  it.each([
    ['signup', 'Bekräfta din e-postadress'],
    ['recovery', 'Återställ ditt lösenord'],
    ['magiclink', 'Din inloggningslänk'],
    ['invite', 'Du har blivit inbjuden'],
    ['email_change', 'Bekräfta din nya e-postadress'],
    ['email_change_current', 'Godkänn ändrad e-postadress'],
  ] as const)('renders %s with the brand app name and action link', (actionType, subject) => {
    const mail = buildAuthEmail({
      actionType,
      appName: 'Siffra',
      actionUrl: URL_EXAMPLE,
    })
    expect(mail.subject).toBe(subject)
    expect(mail.html).toContain('Siffra')
    expect(mail.html).toContain(URL_EXAMPLE_HTML)
    expect(mail.html).not.toMatch(/accounted/i)
    expect(mail.text).toContain(URL_EXAMPLE)
    expect(mail.text).not.toMatch(/accounted/i)
  })

  it('renders the platform default without a brand', () => {
    const mail = buildAuthEmail({
      actionType: 'recovery',
      appName: 'Accounted',
      actionUrl: 'https://app.gnubok.se/auth/callback?token_hash=abc&type=recovery',
    })
    expect(mail.html).toContain('ACCOUNTED')
    expect(mail.html).toContain('https://app.gnubok.se/auth/callback')
    expect(mail.html).toMatchSnapshot()
    expect(mail.text).toMatchSnapshot()
  })

  it('renders the branded recovery mail (snapshot)', () => {
    const mail = buildAuthEmail({
      actionType: 'recovery',
      appName: 'Siffra',
      actionUrl: URL_EXAMPLE,
    })
    expect(mail.html).toMatchSnapshot()
    expect(mail.text).toMatchSnapshot()
  })

  it('tells the user both mails must be clicked for an email change', () => {
    for (const actionType of ['email_change', 'email_change_current'] as const) {
      const mail = buildAuthEmail({
        actionType,
        appName: 'Siffra',
        actionUrl: URL_EXAMPLE,
      })
      expect(mail.text).toContain('två mail')
      expect(mail.text).toContain('länken i båda')
    }
  })

  it('renders the reauthentication code without a link', () => {
    const mail = buildAuthEmail({
      actionType: 'reauthentication',
      appName: 'Siffra',
      otpCode: '123456',
    })
    expect(mail.subject).toBe('Din verifieringskod')
    expect(mail.html).toContain('123456')
    expect(mail.html).not.toContain('<a href')
    expect(mail.text).toContain('Kod: 123456')
  })

  it('renders the BankID signup confirmation with the ignore-and-stay-inactive note', () => {
    // Sent to whatever address the BankID holder typed, so the copy must say
    // the account was opened with BankID and that ignoring the mail leaves it
    // inactive: a stranger must not be nudged into activating it.
    const mail = buildAuthEmail({
      actionType: 'bankid_signup',
      appName: 'Siffra',
      actionUrl: 'https://app.siffra.se/auth/callback?token_hash=abc&type=magiclink',
    })
    expect(mail.subject).toBe('Bekräfta din e-postadress')
    expect(mail.text).toContain('BankID')
    expect(mail.text).toContain('Siffra')
    expect(mail.text).toContain('förblir inaktivt')
    expect(mail.text).toContain(
      'Bekräfta e-postadress: https://app.siffra.se/auth/callback?token_hash=abc&type=magiclink',
    )
    expect(mail.html).toContain('type=magiclink')
    expect(mail.html).not.toMatch(/accounted/i)
  })

  it('falls back to a generic mail for unknown action types', () => {
    const mail = buildAuthEmail({
      actionType: 'some_future_type',
      appName: 'Siffra',
      actionUrl: URL_EXAMPLE,
    })
    expect(mail.subject).toBe('Bekräfta din åtgärd')
    expect(mail.html).toContain(URL_EXAMPLE_HTML)
  })

  it('escapes HTML in the app name', () => {
    const mail = buildAuthEmail({
      actionType: 'recovery',
      appName: '<script>x</script>',
      actionUrl: URL_EXAMPLE,
    })
    expect(mail.html).not.toContain('<script>')
  })
})
