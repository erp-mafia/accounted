import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import {
  generateSkvOmbudAnnouncementHtml,
  generateSkvOmbudAnnouncementText,
  ombudButtonLabel,
  SKV_OMBUD_ANNOUNCEMENT_SUBJECT,
  type SkvOmbudAnnouncementData,
} from '../skatteverket-ombud-announcement-templates'

const data = (overrides: Partial<SkvOmbudAnnouncementData> = {}): SkvOmbudAnnouncementData => ({
  appName: 'Accounted',
  companyNames: ['Exempel AB'],
  settingsUrl: 'https://app.accounted.se/settings/skatteverket',
  logo: null,
  supportEmail: 'support@accounted.se',
  signature: 'founder',
  ...overrides,
})

describe('skatteverket ombud announcement mail', () => {
  it('names the button and the two roles exactly as the settings page shows them', () => {
    const labels = sv.settings_skatteverket_connect
    expect(ombudButtonLabel('Byråappen')).toBe(labels.system_deeplink.replace('{appName}', 'Byråappen'))
    const text = generateSkvOmbudAnnouncementText(data())
    expect(text).toContain(`"${labels.system_behorighet_lasombud}"`)
    expect(text).toContain(`"${labels.system_behorighet_moms}"`)
    expect(text).toContain(`"${labels.system_deeplink.replace('{appName}', 'Accounted')}"`)
  })

  it('is the approved text, with the app name of the brand', () => {
    const text = generateSkvOmbudAnnouncementText(data({ appName: 'Byråappen', signature: 'brand' }))
    expect(SKV_OMBUD_ANNOUNCEMENT_SUBJECT).toBe('Nu slipper du logga in med BankID för skattekontot')
    expect(text).toContain('Nu kan du utse Byråappen som ombud för ditt företag hos Skatteverket.')
    expect(text).toContain('Byråappen kollar automatiskt och visar när det är klart.')
    expect(text).toContain('Deklarationer signerar du som vanligt själv med BankID.')
    expect(text).toContain('Hojta om något strular!')
    expect(text).not.toContain('Accounted')
    expect(text).not.toContain('Emil')
  })

  it('lists several companies and asks for one at a time', () => {
    const text = generateSkvOmbudAnnouncementText(data({ companyNames: ['A AB', 'B AB', 'C AB'] }))
    expect(text).toContain('Det gäller A AB, B AB och C AB. Gör stegen nedan för ett företag i taget')
    expect(text).toContain('ägare eller administratör för 3 företag i Accounted')
  })

  it('escapes company names and draws the brand logo when there is one', () => {
    const html = generateSkvOmbudAnnouncementHtml(
      data({ companyNames: ['<b>A</b> & B'], logo: { src: 'https://cdn.example.se/logo.png', width: 120, height: 40 }, appName: 'Byrå' }),
    )
    expect(html).toContain('&lt;b&gt;A&lt;/b&gt; &amp; B')
    expect(html).toContain('<img src="https://cdn.example.se/logo.png" width="120" height="40" alt="Byrå"')
  })

  it('has no em or en dashes', () => {
    for (const out of [generateSkvOmbudAnnouncementHtml(data()), generateSkvOmbudAnnouncementText(data({ signature: 'brand' }))]) {
      expect(out).not.toMatch(/[–—]/)
    }
  })
})
