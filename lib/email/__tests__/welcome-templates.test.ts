import { describe, it, expect, afterEach } from 'vitest'
import {
  generateWelcomeEmailHtml,
  generateWelcomeEmailSubject,
  generateWelcomeEmailText,
} from '@/lib/email/welcome-templates'
import { getBranding, registerBrandingService } from '@/lib/branding/service'

const named = { firstName: 'Jakob', lang: 'sv' as const }
const anonymous = { firstName: null, lang: 'sv' as const }
const english = { firstName: 'Jakob', lang: 'en' as const }

afterEach(() => {
  registerBrandingService({})
})

describe('welcome email templates', () => {
  it('greets by first name and puts it in the subject', () => {
    const { appName } = getBranding()
    expect(generateWelcomeEmailSubject(named)).toBe(`Välkommen till ${appName}, Jakob`)
    expect(generateWelcomeEmailHtml(named)).toContain('Hej Jakob,')
    expect(generateWelcomeEmailText(named)).toContain('Hej Jakob,')
  })

  it('falls back to a bare greeting when no name is known', () => {
    const { appName } = getBranding()
    expect(generateWelcomeEmailSubject(anonymous)).toBe(`Välkommen till ${appName}`)
    expect(generateWelcomeEmailHtml(anonymous)).toContain('>Hej,</p>')
    expect(generateWelcomeEmailText(anonymous)).toMatch(/^Hej,\n/)
  })

  it('escapes the user-controlled name in HTML and keeps the subject single-line', () => {
    const hostile = { firstName: '<b>Jakob</b>\r\nBcc: x@evil.test', lang: 'sv' as const }
    const html = generateWelcomeEmailHtml(hostile)
    expect(html).not.toContain('<b>Jakob</b>')
    expect(html).toContain('&lt;b&gt;Jakob&lt;/b&gt;')
    const subject = generateWelcomeEmailSubject(hostile)
    expect(subject).not.toMatch(/[\r\n]/)
  })

  it('is signed by the configured sender and replies go to a person', () => {
    const { welcomeSenderName } = getBranding()
    expect(welcomeSenderName).toBe('Jakob')
    const text = generateWelcomeEmailText(named)
    expect(text).toContain('Mvh\nJakob')
    expect(text).toContain('så hjälper jag dig')
    expect(generateWelcomeEmailHtml(named)).toContain('Mvh<br>\n        Jakob')
  })

  it('signs as the app when branding has no sender name', () => {
    registerBrandingService({ welcomeSenderName: '' })
    const { appName } = getBranding()
    const text = generateWelcomeEmailText(named)
    expect(text).toContain(`Med vänliga hälsningar,\n${appName}`)
    expect(text).toContain('så hjälper vi dig')
    expect(text).not.toContain('jag')
  })

  it('renders the English variant from the locale', () => {
    const { appName } = getBranding()
    expect(generateWelcomeEmailSubject(english)).toBe(`Welcome to ${appName}, Jakob`)
    const text = generateWelcomeEmailText(english)
    expect(text).toContain('Hi Jakob,')
    expect(text).toContain('Kind regards,\nJakob')
    expect(generateWelcomeEmailHtml(english)).toContain('<html lang="en">')
  })

  it('shows the destination URL as plain text next to the button', () => {
    const { appUrl } = getBranding()
    const html = generateWelcomeEmailHtml(named)
    const mentions = html.split(appUrl).length - 1
    expect(mentions).toBeGreaterThanOrEqual(2)
    expect(generateWelcomeEmailText(named)).toContain(appUrl)
  })

  it('names the same three steps the Hem checklist shows, in its order', () => {
    const text = generateWelcomeEmailText(named)
    const books = text.indexOf('Få in din bokföring')
    const bank = text.indexOf('Koppla banken')
    const receipt = text.indexOf('Fota ett kvitto')
    expect(books).toBeGreaterThan(-1)
    expect(bank).toBeGreaterThan(books)
    expect(receipt).toBeGreaterThan(bank)
  })

  it('explains why the recipient got the email', () => {
    expect(generateWelcomeEmailHtml(named)).toContain('Du får det här mejlet för att')
    expect(generateWelcomeEmailText(named)).toContain('Du får det här mejlet för att')
  })

  it('keeps the voice rules: no dashes, no emoji, at most one exclamation, short', () => {
    for (const data of [named, anonymous, english]) {
      const text = generateWelcomeEmailText(data)
      const html = generateWelcomeEmailHtml(data)
      expect(text).not.toMatch(/[–—]/)
      expect(html).not.toMatch(/[–—]/)
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
      expect((text.match(/!/g) ?? []).length).toBeLessThanOrEqual(1)
      // The letter itself (everything before the footer line) stays under the
      // ~105-word ceiling a personal email should respect.
      const body = text.split('\n\n').slice(0, -1).join(' ')
      expect(body.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(105)
    }
  })

  it('uses no alarm colors in the chrome', () => {
    expect(generateWelcomeEmailHtml(named)).not.toMatch(/#dc2626|#ea580c|#ef4444|#b91c1c/i)
  })
})
