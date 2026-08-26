import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildPasswordResetRedirectTo,
  getCanonicalAppOrigin,
  resolveRequestAppOrigin,
  resolveTrustedAppOrigin,
} from '../trusted-app-origin'

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL
const ORIGINAL_WHITELABEL_DOMAINS = process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS

describe('trusted application origins', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test'
    delete process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS
  })

  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL

    if (ORIGINAL_WHITELABEL_DOMAINS === undefined) {
      delete process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS
    } else {
      process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS = ORIGINAL_WHITELABEL_DOMAINS
    }
  })

  it('uses an exact registered white-label host over HTTPS', () => {
    process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS = 'portal.brand.test, books.partner.test'

    expect(resolveTrustedAppOrigin('https://portal.brand.test')).toBe(
      'https://portal.brand.test',
    )
    expect(resolveTrustedAppOrigin('PORTAL.BRAND.TEST.')).toBe(
      'https://portal.brand.test',
    )
  })

  it('rejects spoofed, credential, wildcard, and non-default-port hosts', () => {
    process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS = 'portal.brand.test,*.wildcard.test'

    for (const candidate of [
      'https://portal.brand.test.attacker.test',
      'https://portal.brand.test@attacker.test',
      'https://child.wildcard.test',
      'https://portal.brand.test:444',
    ]) {
      expect(resolveTrustedAppOrigin(candidate), candidate).toBe(
        'https://app.accounted.test',
      )
    }
  })

  it('falls back to the canonical origin when the request host is not registered', () => {
    expect(resolveTrustedAppOrigin('https://unregistered.test')).toBe(
      'https://app.accounted.test',
    )
    expect(resolveTrustedAppOrigin(null)).toBe('https://app.accounted.test')
  })

  it('normalises the canonical URL to its origin and has a local safe fallback', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test/base?ignored=yes'
    expect(getCanonicalAppOrigin()).toBe('https://app.accounted.test')

    process.env.NEXT_PUBLIC_APP_URL = 'javascript:alert(1)'
    expect(getCanonicalAppOrigin()).toBe('http://localhost:3000')
  })

  it('validates the request URL and ignores a spoofed forwarded host', () => {
    process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS = 'portal.brand.test'

    const trusted = new Request('https://portal.brand.test/api/company/members/invite', {
      headers: { 'x-forwarded-host': 'attacker.test' },
    })
    const spoofed = new Request('https://attacker.test/api/company/members/invite', {
      headers: { 'x-forwarded-host': 'portal.brand.test' },
    })

    expect(resolveRequestAppOrigin(trusted)).toBe('https://portal.brand.test')
    expect(resolveRequestAppOrigin(spoofed)).toBe('https://app.accounted.test')
  })
})

describe('password reset callback', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test'
    process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS = 'portal.brand.test'
  })

  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL

    if (ORIGINAL_WHITELABEL_DOMAINS === undefined) {
      delete process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS
    } else {
      process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS = ORIGINAL_WHITELABEL_DOMAINS
    }
  })

  it('keeps a registered brand callback on the brand domain', () => {
    expect(buildPasswordResetRedirectTo('https://portal.brand.test')).toBe(
      'https://portal.brand.test/auth/callback?next=/reset-password',
    )
  })

  it('uses the allowlisted canonical callback for an unknown browser origin', () => {
    expect(buildPasswordResetRedirectTo('https://attacker.test')).toBe(
      'https://app.accounted.test/auth/callback?next=/reset-password',
    )
  })
})
