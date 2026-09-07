import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveBrandResultByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultByHostMock(...args),
}))

import {
  buildPasswordResetRedirectTo,
  getCanonicalAppOrigin,
  requestHost,
  resolveRequestAppOrigin,
  resolveTrustedAppOrigin,
} from '../trusted-app-origin'

const REGISTERED = new Set(['portal.brand.test', 'books.partner.test'])

const ORIGINAL_ENV = {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  VERCEL_URL: process.env.VERCEL_URL,
  VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('trusted application origins', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test'
    delete process.env.VERCEL_URL
    delete process.env.VERCEL_BRANCH_URL
    resolveBrandResultByHostMock.mockImplementation(async (host: string) => ({
      brand: REGISTERED.has(host) ? { domain: host } : null,
      lookupFailed: false,
    }))
  })

  afterEach(restoreEnv)

  it('uses an exact registered brand host over HTTPS', async () => {
    expect(await resolveTrustedAppOrigin('https://portal.brand.test')).toBe(
      'https://portal.brand.test',
    )
    expect(await resolveTrustedAppOrigin('PORTAL.BRAND.TEST.')).toBe(
      'https://portal.brand.test',
    )
    expect(resolveBrandResultByHostMock).toHaveBeenCalledWith('portal.brand.test')
  })

  it('rejects spoofed, credential, suffix, and non-default-port hosts', async () => {
    for (const candidate of [
      'https://portal.brand.test.attacker.test',
      'https://portal.brand.test@attacker.test',
      'https://child.portal.brand.test',
      'https://portal.brand.test:444',
    ]) {
      expect(await resolveTrustedAppOrigin(candidate), candidate).toBe(
        'https://app.accounted.test',
      )
    }
  })

  it('falls back to the canonical origin when the host is not registered', async () => {
    expect(await resolveTrustedAppOrigin('https://unregistered.test')).toBe(
      'https://app.accounted.test',
    )
    expect(await resolveTrustedAppOrigin(null)).toBe('https://app.accounted.test')
  })

  it('does not consult the registry for the canonical host itself', async () => {
    expect(await resolveTrustedAppOrigin('app.accounted.test')).toBe(
      'https://app.accounted.test',
    )
    expect(resolveBrandResultByHostMock).not.toHaveBeenCalled()
  })

  it('falls back to the canonical origin when the brands lookup fails', async () => {
    resolveBrandResultByHostMock.mockResolvedValue({ brand: null, lookupFailed: true })

    expect(await resolveTrustedAppOrigin('https://portal.brand.test')).toBe(
      'https://app.accounted.test',
    )
  })

  it("trusts this deployment's own Vercel hostnames, but no other *.vercel.app", async () => {
    process.env.VERCEL_URL = 'erp-base-abc123-team.vercel.app'
    process.env.VERCEL_BRANCH_URL = 'erp-base-git-feature-team.vercel.app'

    expect(await resolveTrustedAppOrigin('erp-base-abc123-team.vercel.app')).toBe(
      'https://erp-base-abc123-team.vercel.app',
    )
    expect(await resolveTrustedAppOrigin('https://erp-base-git-feature-team.vercel.app')).toBe(
      'https://erp-base-git-feature-team.vercel.app',
    )
    expect(await resolveTrustedAppOrigin('https://someone-else.vercel.app')).toBe(
      'https://app.accounted.test',
    )
  })

  it('normalises the canonical URL to its origin and has a local safe fallback', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test/base?ignored=yes'
    expect(getCanonicalAppOrigin()).toBe('https://app.accounted.test')

    process.env.NEXT_PUBLIC_APP_URL = 'javascript:alert(1)'
    expect(getCanonicalAppOrigin()).toBe('http://localhost:3000')
  })

  it('reads the forwarded host first, then Host, then the request URL', () => {
    expect(
      requestHost(
        new Request('https://internal/api/x', {
          headers: { host: 'internal', 'x-forwarded-host': 'portal.brand.test' },
        }),
      ),
    ).toBe('portal.brand.test')
    expect(
      requestHost(new Request('https://internal/api/x', { headers: { host: 'books.partner.test' } })),
    ).toBe('books.partner.test')
    expect(requestHost(new Request('https://portal.brand.test/api/x'))).toBe('portal.brand.test')
  })

  it('resolves a request through the registry and ignores an unregistered forwarded host', async () => {
    const registered = new Request('https://internal/api/company/members/invite', {
      headers: { 'x-forwarded-host': 'portal.brand.test' },
    })
    const spoofed = new Request('https://portal.brand.test/api/company/members/invite', {
      headers: { 'x-forwarded-host': 'attacker.test' },
    })

    expect(await resolveRequestAppOrigin(registered)).toBe('https://portal.brand.test')
    expect(await resolveRequestAppOrigin(spoofed)).toBe('https://app.accounted.test')
  })
})

describe('password reset callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test'
    resolveBrandResultByHostMock.mockImplementation(async (host: string) => ({
      brand: REGISTERED.has(host) ? { domain: host } : null,
      lookupFailed: false,
    }))
  })

  afterEach(restoreEnv)

  it('keeps a registered brand callback on the brand domain', async () => {
    expect(await buildPasswordResetRedirectTo('portal.brand.test')).toBe(
      'https://portal.brand.test/auth/callback?next=/reset-password',
    )
  })

  it('uses the canonical callback for an unknown host', async () => {
    expect(await buildPasswordResetRedirectTo('attacker.test')).toBe(
      'https://app.accounted.test/auth/callback?next=/reset-password',
    )
  })
})
