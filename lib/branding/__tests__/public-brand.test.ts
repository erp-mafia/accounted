import { describe, it, expect } from 'vitest'
import { getBranding } from '@/lib/branding/service'
import {
  toPublicBrand,
  mergeClientBranding,
  type PublicBrand,
} from '@/lib/branding/public-brand'
import type { Brand } from '@/lib/branding/resolve'

const fullBrand: Brand = {
  id: 'brand-1',
  teamId: 'team-1',
  domain: 'app.siffra.se',
  appName: 'Siffra',
  logoUrl: 'https://cdn.example.com/storage/v1/object/public/brand-logos/siffra.png',
  brandColor: '#2563eb',
  chromeColor: null,
  fontKey: 'default',
  supportEmail: 'support@siffra.se',
  authEmailFrom: null,
  senderDomain: 'mail.siffra.se',
  senderDomainStatus: 'verified',
  resendDomainId: 'rd_123',
}

describe('toPublicBrand', () => {
  it('keeps only the client-safe fields', () => {
    const pub = toPublicBrand(fullBrand)
    expect(pub).toEqual({
      appName: 'Siffra',
      logoUrl: fullBrand.logoUrl,
      supportEmail: 'support@siffra.se',
      authEmailFrom: null,
      brandColor: '#2563eb',
      fontKey: 'default',
      domain: 'app.siffra.se',
    })
    // Ops-internal email plumbing must never cross to the client bundle.
    expect(pub).not.toHaveProperty('senderDomain')
    expect(pub).not.toHaveProperty('senderDomainStatus')
    expect(pub).not.toHaveProperty('resendDomainId')
    expect(pub).not.toHaveProperty('teamId')
  })
})

describe('mergeClientBranding', () => {
  const base = getBranding()

  it('returns plain getBranding() values when there is no brand (the additive guarantee)', () => {
    const merged = mergeClientBranding(base, null)
    expect(merged.brand).toBeNull()
    expect(merged.logoUrl).toBeNull()
    // Every base field passes through untouched.
    expect(merged).toMatchObject(base)
    expect(merged.appName).toBe(base.appName)
    expect(merged.supportEmail).toBe(base.supportEmail)
    expect(merged.authEmailFrom).toBe(base.authEmailFrom)
    expect(merged.themeColor).toBe(base.themeColor)
    expect(merged.logoPath).toBe(base.logoPath)
  })

  it('layers brand values over the defaults when a brand is active', () => {
    const pub = toPublicBrand(fullBrand)
    const merged = mergeClientBranding(base, pub)
    expect(merged.appName).toBe('Siffra')
    expect(merged.supportEmail).toBe('support@siffra.se')
    expect(merged.themeColor).toBe('#2563eb')
    expect(merged.logoUrl).toBe(fullBrand.logoUrl)
    expect(merged.brand).toEqual(pub)
    // Untouched defaults survive the merge.
    expect(merged.logoPath).toBe(base.logoPath)
    expect(merged.appDescription).toBe(base.appDescription)
  })

  it('falls back to the default authEmailFrom when the brand has none', () => {
    const withoutAuthFrom: PublicBrand = { ...toPublicBrand(fullBrand), authEmailFrom: null }
    expect(mergeClientBranding(base, withoutAuthFrom).authEmailFrom).toBe(base.authEmailFrom)

    const withAuthFrom: PublicBrand = {
      ...toPublicBrand(fullBrand),
      authEmailFrom: 'noreply@siffra.se',
    }
    expect(mergeClientBranding(base, withAuthFrom).authEmailFrom).toBe('noreply@siffra.se')
  })
})
