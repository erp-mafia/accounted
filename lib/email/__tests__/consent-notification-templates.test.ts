import { describe, it, expect } from 'vitest'
import {
  generateConsentExpiryEmailHtml,
  generateConsentExpiryEmailText,
  generateConsentExpiryEmailSubject,
} from '@/lib/email/consent-notification-templates'
import { getBranding } from '@/lib/branding/service'

const expired = {
  bankName: 'SEB',
  daysUntilExpiry: 0,
  renewalUrl: 'https://app.gnubok.se/settings/banking',
  companyName: 'Glimworks AB',
  isExpired: true,
}

const expiringSoon = {
  ...expired,
  daysUntilExpiry: 3,
  isExpired: false,
}

describe('consent expiry email templates', () => {
  it('signs off as the app, never as the recipient company', () => {
    const html = generateConsentExpiryEmailHtml(expired)
    const text = generateConsentExpiryEmailText(expired)
    const { appName } = getBranding()

    expect(html).toContain(`Med vänliga hälsningar,<br>\n          <strong>${appName}</strong>`)
    expect(text).toContain(`Med vänliga hälsningar,\n${appName}`)
    expect(html).not.toContain('Med vänliga hälsningar,<br>\n          <strong>Glimworks')
  })

  it('uses no alarm colors in the chrome', () => {
    for (const data of [expired, expiringSoon]) {
      const html = generateConsentExpiryEmailHtml(data)
      expect(html).not.toMatch(/#dc2626|#ea580c|#ef4444|#b91c1c/i)
      expect(html).not.toContain('Åtgärd krävs')
    }
  })

  it('names the bank, the company, and the destination URL', () => {
    const html = generateConsentExpiryEmailHtml(expired)
    expect(html).toContain('SEB')
    expect(html).toContain('Glimworks AB')
    // The URL is shown as plain text next to the button so the recipient can
    // verify where it leads before clicking.
    const urlMentions = html.split(expired.renewalUrl).length - 1
    expect(urlMentions).toBeGreaterThanOrEqual(2)
  })

  it('explains why the recipient got the email', () => {
    const html = generateConsentExpiryEmailHtml(expired)
    const text = generateConsentExpiryEmailText(expired)
    const { supportEmail } = getBranding()
    expect(html).toContain('Du får det här mejlet eftersom')
    expect(html).toContain(supportEmail)
    expect(text).toContain('Du får det här mejlet eftersom')
    expect(text).toContain(supportEmail)
  })

  it('omits the company row cleanly when no company name is available', () => {
    const data = { ...expired, companyName: '' }
    const html = generateConsentExpiryEmailHtml(data)
    const text = generateConsentExpiryEmailText(data)
    expect(html).not.toContain('Företag')
    expect(html).not.toContain('för </')
    expect(text).not.toContain('Företag:')
    expect(generateConsentExpiryEmailSubject(data)).toBe('Förnya bankkopplingen till SEB')
  })

  it('generates calm, specific subjects', () => {
    expect(generateConsentExpiryEmailSubject(expired)).toBe(
      'Förnya bankkopplingen till SEB - Glimworks AB'
    )
    expect(generateConsentExpiryEmailSubject(expiringSoon)).toBe(
      'Bankkopplingen till SEB löper ut om 3 dagar - Glimworks AB'
    )
    expect(generateConsentExpiryEmailSubject({ ...expiringSoon, daysUntilExpiry: 1 })).toBe(
      'Bankkopplingen till SEB löper ut om 1 dag - Glimworks AB'
    )
  })

  it('pluralizes days in the expiring-soon body', () => {
    const html = generateConsentExpiryEmailHtml({ ...expiringSoon, daysUntilExpiry: 1 })
    expect(html).toContain('löper ut om 1 dag')
    const html3 = generateConsentExpiryEmailHtml(expiringSoon)
    expect(html3).toContain('löper ut om 3 dagar')
  })
})
