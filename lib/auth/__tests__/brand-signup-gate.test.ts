import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import type { Brand } from '@/lib/branding/resolve'

const serviceClient = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => serviceClient.current),
}))

// The gate resolves via resolveBrandResultByHost ({ brand, lookupFailed });
// resolveBrandDomainBounce still uses resolveBrandByHost. Mock both off one
// brand value, and let tests override lookupFailed when they need it.
const resolveBrandByHostMock = vi.hoisted(() => vi.fn())
const resolveBrandResultMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/branding/resolve')>()
  return {
    ...actual,
    resolveBrandByHost: (...args: unknown[]) => resolveBrandByHostMock(...args),
    resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultMock(...args),
  }
})

import {
  evaluateBrandSignupGate,
  isEmailOnBrandAllowlist,
  readInviteTokenFromCookieHeader,
  resolveBrandDomainBounce,
} from '@/lib/auth/brand-signup-gate'

function makeBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: 'brand-1',
    teamId: 'team-1',
    domain: 'app.siffra.se',
    appName: 'Siffra',
    logoUrl: null,
    faviconUrl: null,
    brandColor: '#123456',
    chromeColor: null,
    fontKey: 'default',
    supportEmail: 'support@siffra.se',
    authEmailFrom: null,
    senderDomain: null,
    senderDomainStatus: 'unverified',
    resendDomainId: null,
    signupMode: 'invite_only',
    ...overrides,
  }
}

let mock: ReturnType<typeof createQueuedMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  serviceClient.current = mock.supabase
  // By default the strict resolver mirrors resolveBrandByHostMock's value
  // with lookupFailed:false, so the existing tests keep configuring one mock.
  // The fail-safe test overrides this to return lookupFailed:true.
  resolveBrandResultMock.mockImplementation(async (host: string) => ({
    brand: await resolveBrandByHostMock(host),
    lookupFailed: false,
  }))
})

describe('evaluateBrandSignupGate', () => {
  it('allows when the host has no brand', async () => {
    resolveBrandByHostMock.mockResolvedValue(null)
    const result = await evaluateBrandSignupGate({
      host: 'app.accounted.se',
      email: 'anyone@example.com',
    })
    expect(result).toEqual({ allowed: true, brand: null, via: 'no_brand' })
  })

  it('allows with no host at all', async () => {
    const result = await evaluateBrandSignupGate({ host: '', email: 'a@b.se' })
    expect(result.allowed).toBe(true)
    expect(resolveBrandByHostMock).not.toHaveBeenCalled()
  })

  it('allows on an open brand without touching the allowlist', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand({ signupMode: 'open' }))
    const result = await evaluateBrandSignupGate({
      host: 'app.siffra.se',
      email: 'anyone@example.com',
    })
    expect(result.allowed).toBe(true)
    expect(result.allowed && result.via).toBe('open')
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('allows an allowlisted email on an invite-only brand, case-insensitively', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    mock.enqueue({ data: { id: 'entry-1' } })

    const result = await evaluateBrandSignupGate({
      host: 'app.siffra.se',
      email: '  Kund@Example.COM ',
    })

    expect(result.allowed).toBe(true)
    expect(result.allowed && result.via).toBe('allowlist')
    // The lookup used the normalized address.
    expect(mock.findCalls('brand_signup_allowlist', 'eq')).toContainEqual([
      'email',
      'kund@example.com',
    ])
  })

  it('blocks a non-allowlisted email on an invite-only brand', async () => {
    const brand = makeBrand()
    resolveBrandByHostMock.mockResolvedValue(brand)
    mock.enqueue({ data: null })

    const result = await evaluateBrandSignupGate({
      host: 'app.siffra.se',
      email: 'stranger@example.com',
    })

    expect(result).toEqual({ allowed: false, brand })
  })

  it('fails safe (lookupFailed) when the brand lookup itself errors', async () => {
    resolveBrandResultMock.mockResolvedValue({ brand: null, lookupFailed: true })

    const result = await evaluateBrandSignupGate({
      host: 'app.siffra.se',
      email: 'anyone@example.com',
    })

    // Must NOT degrade to allowed no_brand: a transient DB error cannot open
    // an invite-only domain.
    expect(result).toEqual({ allowed: false, brand: null, lookupFailed: true })
  })

  it('fails closed when the allowlist lookup errors', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    mock.enqueue({ data: null, error: { message: 'boom' } })

    const result = await evaluateBrandSignupGate({
      host: 'app.siffra.se',
      email: 'kund@example.com',
    })

    expect(result.allowed).toBe(false)
  })

  it('allows a pending unexpired invite for the same email', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    // Allowlist miss, then the invite row.
    mock.enqueueMany([
      { data: null },
      {
        data: {
          email: 'Invitee@Example.com',
          status: 'pending',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    ])

    const result = await evaluateBrandSignupGate({
      host: 'app.siffra.se',
      email: 'invitee@example.com',
      inviteToken: 'gnubok_inv_abc',
    })

    expect(result.allowed).toBe(true)
    expect(result.allowed && result.via).toBe('invite')
    // Lookup is by token hash, never the raw token.
    expect(mock.findCall('company_invitations', 'eq')).toEqual([
      'token_hash',
      hashInviteToken('gnubok_inv_abc'),
    ])
  })

  it('blocks when the invite is for a different email', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    mock.enqueueMany([
      { data: null },
      {
        data: {
          email: 'someone-else@example.com',
          status: 'pending',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    ])

    const result = await evaluateBrandSignupGate({
      host: 'app.siffra.se',
      email: 'stranger@example.com',
      inviteToken: 'gnubok_inv_abc',
    })

    expect(result.allowed).toBe(false)
  })

  it('blocks when the invite is expired', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    mock.enqueueMany([
      { data: null },
      {
        data: {
          email: 'invitee@example.com',
          status: 'pending',
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    ])

    const result = await evaluateBrandSignupGate({
      host: 'app.siffra.se',
      email: 'invitee@example.com',
      inviteToken: 'gnubok_inv_abc',
    })

    expect(result.allowed).toBe(false)
  })
})

describe('isEmailOnBrandAllowlist', () => {
  it('returns false for an empty email without querying', async () => {
    expect(await isEmailOnBrandAllowlist('brand-1', '   ')).toBe(false)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })
})

describe('resolveBrandDomainBounce', () => {
  const base = {
    host: 'app.siffra.se',
    userEmail: 'user@example.com',
    teamIds: [] as string[],
    companyTeamIds: [] as Array<string | null>,
    hasPendingInviteCookie: false,
    canonicalAppUrl: 'https://app.accounted.se',
  }

  it('stays on open brands and brandless hosts', async () => {
    resolveBrandByHostMock.mockResolvedValue(null)
    expect(await resolveBrandDomainBounce(base)).toBeNull()

    resolveBrandByHostMock.mockResolvedValue(makeBrand({ signupMode: 'open' }))
    expect(await resolveBrandDomainBounce(base)).toBeNull()
  })

  it('stays for brand team members and brand-homed company members', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    expect(
      await resolveBrandDomainBounce({ ...base, teamIds: ['team-1'] }),
    ).toBeNull()
    expect(
      await resolveBrandDomainBounce({ ...base, companyTeamIds: [null, 'team-1'] }),
    ).toBeNull()
  })

  it('stays when a pending invite cookie rides along', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    expect(
      await resolveBrandDomainBounce({ ...base, hasPendingInviteCookie: true }),
    ).toBeNull()
  })

  it('stays for an allowlisted email', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    mock.enqueue({ data: { id: 'entry-1' } })
    expect(await resolveBrandDomainBounce(base)).toBeNull()
  })

  it('bounces a non-belonging session to the canonical URL', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    mock.enqueue({ data: null })
    expect(await resolveBrandDomainBounce(base)).toBe('https://app.accounted.se')
  })

  it('never bounces onto the same host', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    mock.enqueue({ data: null })
    expect(
      await resolveBrandDomainBounce({
        ...base,
        canonicalAppUrl: 'https://app.siffra.se',
      }),
    ).toBeNull()
  })

  it('never bounces on a malformed canonical URL', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    mock.enqueue({ data: null })
    expect(
      await resolveBrandDomainBounce({ ...base, canonicalAppUrl: '' }),
    ).toBeNull()
  })
})

describe('readInviteTokenFromCookieHeader', () => {
  it('reads the invite token among other cookies', () => {
    expect(
      readInviteTokenFromCookieHeader(
        'a=1; gnubok-invite-token=gnubok_inv_x; b=2',
      ),
    ).toBe('gnubok_inv_x')
  })

  it('decodes URI-encoded values and tolerates missing cookies', () => {
    expect(
      readInviteTokenFromCookieHeader('gnubok-invite-token=abc%3D%3D'),
    ).toBe('abc==')
    expect(readInviteTokenFromCookieHeader(null)).toBeNull()
    expect(readInviteTokenFromCookieHeader('a=1; b=2')).toBeNull()
    expect(readInviteTokenFromCookieHeader('gnubok-invite-token=')).toBeNull()
  })
})
