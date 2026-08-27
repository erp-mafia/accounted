import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Brand } from '@/lib/branding/resolve'

const resolveBrandForCompanyMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandForCompany: resolveBrandForCompanyMock,
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted', appUrl: 'https://app.gnubok.se' }),
}))

import {
  getSenderForBrand,
  getSenderForCompany,
  getBaseUrlForBrand,
  getBaseUrlForCompany,
} from '../brand-sender'

function makeBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: 'brand-1',
    teamId: 'team-1',
    domain: 'app.siffra.se',
    appName: 'Siffra',
    logoUrl: null,
    brandColor: '#123456',
    chromeColor: null,
    fontKey: 'default',
    supportEmail: 'support@siffra.se',
    authEmailFrom: 'noreply@post.siffra.se',
    senderDomain: 'post.siffra.se',
    senderDomainStatus: 'verified',
    resendDomainId: 'rd-1',
    signupMode: 'open',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getSenderForBrand', () => {
  it('returns platform defaults (all null) for no brand', () => {
    expect(getSenderForBrand(null)).toEqual({
      fromName: null,
      fromAddress: null,
      replyTo: null,
      brand: null,
    })
  })

  it('sends from the brand address when the sender domain is verified', () => {
    const brand = makeBrand()
    expect(getSenderForBrand(brand)).toEqual({
      fromName: 'Siffra',
      fromAddress: 'noreply@post.siffra.se',
      replyTo: 'support@siffra.se',
      brand,
    })
  })

  it('falls back to the via-platform pattern when the domain is unverified', () => {
    const brand = makeBrand({ senderDomainStatus: 'pending' })
    expect(getSenderForBrand(brand)).toEqual({
      fromName: 'Siffra',
      fromAddress: null,
      replyTo: 'support@siffra.se',
      brand,
    })
  })

  it('falls back when the domain is verified but authEmailFrom is missing', () => {
    const brand = makeBrand({ authEmailFrom: null })
    const sender = getSenderForBrand(brand)
    expect(sender.fromAddress).toBeNull()
    expect(sender.fromName).toBe('Siffra')
  })
})

describe('getSenderForCompany', () => {
  it('resolves through resolveBrandForCompany', async () => {
    const brand = makeBrand()
    resolveBrandForCompanyMock.mockResolvedValue(brand)
    const sender = await getSenderForCompany('company-1')
    expect(resolveBrandForCompanyMock).toHaveBeenCalledWith('company-1')
    expect(sender.fromAddress).toBe('noreply@post.siffra.se')
  })

  it('returns platform defaults for a brandless company', async () => {
    resolveBrandForCompanyMock.mockResolvedValue(null)
    const sender = await getSenderForCompany('company-1')
    expect(sender).toEqual({ fromName: null, fromAddress: null, replyTo: null, brand: null })
  })
})

describe('base URLs', () => {
  it('uses the brand home domain when a brand exists', () => {
    expect(getBaseUrlForBrand(makeBrand())).toBe('https://app.siffra.se')
  })

  it('uses the canonical app URL without a brand', () => {
    expect(getBaseUrlForBrand(null)).toBe('https://app.gnubok.se')
  })

  it('getBaseUrlForCompany resolves the brand by company', async () => {
    resolveBrandForCompanyMock.mockResolvedValue(makeBrand())
    await expect(getBaseUrlForCompany('company-1')).resolves.toBe('https://app.siffra.se')
    resolveBrandForCompanyMock.mockResolvedValue(null)
    await expect(getBaseUrlForCompany('company-2')).resolves.toBe('https://app.gnubok.se')
  })
})
