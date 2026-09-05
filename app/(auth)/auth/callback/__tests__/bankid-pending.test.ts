/**
 * Pending BankID identities at /auth/callback (security audit 2026-09).
 *
 * The BankID signup leaves the auth user unconfirmed with
 * app_metadata.bankid_pending and a bankid_identities row whose
 * email_verified_at is NULL. Clicking the confirmation mail lands here: the
 * identity is promoted (email_verified_at set, bankid_linked granted, flag
 * removed) unless the account was adopted through another credential in the
 * meantime, in which case the pending link is revoked instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const verifyOtp = vi.fn()
const exchangeCodeForSession = vi.fn()
const getUserById = vi.fn()
const updateUserById = vi.fn()
/** revoke_user_sessions: kills the BankID holder's sessions on revoke. */
const rpc = vi.fn()

/** Every builder call on the service client, in order: { table, method, args }. */
const serviceCalls: Array<{ table: string; method: string; args: unknown[] }> = []
let pendingLookup: { data: unknown; error: unknown } = { data: null, error: null }
let writeResult: { error: unknown } = { error: null }

function serviceChain(table: string): unknown {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === 'then') {
        // select().eq().is().maybeSingle() resolves to the lookup; delete()/
        // update() chains resolve to the write result.
        const isLookup = serviceCalls.some((c) => c.table === table && c.method === 'select')
          && !serviceCalls.some((c) => c.table === table && (c.method === 'delete' || c.method === 'update'))
        return (resolve: (v: unknown) => void) => resolve(isLookup ? pendingLookup : writeResult)
      }
      return (...args: unknown[]) => {
        serviceCalls.push({ table, method: String(prop), args })
        return serviceChain(table)
      }
    },
  }
  return new Proxy({}, handler)
}

// The SSR client is created twice per confirmation: once with the anon key
// (verifyOtp, getUser) and once with the service-role key (bankid_identities,
// auth.admin). Route by key so the test sees exactly what each one did.
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn((_url: string, key: string) => {
    if (key === 'service-role-key') {
      return {
        from: vi.fn((table: string) => serviceChain(table)),
        auth: { admin: { getUserById, updateUserById } },
        rpc,
      }
    }
    const chain: Record<string, ReturnType<typeof vi.fn>> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn().mockResolvedValue({ data: { team_id: 'team-1' }, error: null }),
    }
    return {
      auth: {
        verifyOtp,
        exchangeCodeForSession,
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null }),
        },
      },
      from: vi.fn(() => chain),
      rpc: vi.fn(),
    }
  }),
}))

vi.mock('@/lib/auth/invite-tokens', () => ({ hashInviteToken: vi.fn() }))
vi.mock('@/lib/company/pending-invites', () => ({
  acceptPendingTeamInviteByToken: vi.fn().mockResolvedValue({ status: 'invalid' }),
}))
vi.mock('@/lib/company/landing-server', () => ({
  resolveLandingDestination: vi.fn().mockResolvedValue('/'),
}))

import { GET } from '../route'

const pendingUser = {
  id: 'user-1',
  email: 'typed@example.com',
  email_confirmed_at: undefined,
  identities: [{ provider: 'email' }],
  app_metadata: { bankid_pending: true, has_password: false },
}

function request(type: string, next?: string) {
  const url = new URL('http://localhost:3000/auth/callback')
  url.searchParams.set('token_hash', 'abc')
  url.searchParams.set('type', type)
  if (next) url.searchParams.set('next', next)
  return new NextRequest(url)
}

function identityWrites() {
  return serviceCalls.filter((c) => c.table === 'bankid_identities')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
  serviceCalls.length = 0
  pendingLookup = { data: { id: 'identity-1' }, error: null }
  writeResult = { error: null }
  getUserById.mockResolvedValue({ data: { user: pendingUser }, error: null })
  updateUserById.mockResolvedValue({ data: {}, error: null })
  rpc.mockResolvedValue({ data: 1, error: null })
})

/** An unsigned JWT-shaped token whose payload carries a session_id claim. */
function accessTokenWithSession(sessionId: string): string {
  const b64 = (s: string) => Buffer.from(s).toString('base64url')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify({ sub: 'user-1', session_id: sessionId }))}.sig`
}

describe('GET /auth/callback: pending BankID identity', () => {
  it('promotes the identity when the BankID holder clicks the confirmation mail', async () => {
    verifyOtp.mockResolvedValue({ data: { user: pendingUser, session: {} }, error: null })

    const response = await GET(request('magiclink'))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/')

    const writes = identityWrites()
    expect(writes.map((c) => c.method)).toEqual([
      'select', 'eq', 'is', 'maybeSingle', // pending lookup
      'update', 'eq', 'is', // promotion, scoped to this user's unverified row
    ])
    expect(writes[1].args).toEqual(['user_id', 'user-1'])
    expect(writes[2].args).toEqual(['email_verified_at', null])
    const [payload] = writes[4].args as [Record<string, unknown>]
    expect(typeof payload.email_verified_at).toBe('string')
    expect(writes[5].args).toEqual(['user_id', 'user-1'])
    expect(writes[6].args).toEqual(['email_verified_at', null])

    // Only now does the account get the MFA exemption; the flag goes away.
    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { has_password: false, bankid_linked: true, bankid_pending: null },
    })
  })

  it('does nothing for a confirmation without the bankid_pending flag (ordinary signups cost nothing)', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'user-1', app_metadata: { provider: 'email' } }, session: {} },
      error: null,
    })

    await GET(request('signup'))

    expect(identityWrites()).toHaveLength(0)
    expect(getUserById).not.toHaveBeenCalled()
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('does nothing when the OTP was rejected', async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { message: 'expired' } })

    const response = await GET(request('magiclink'))

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=auth_error&flow=signup',
    )
    expect(identityWrites()).toHaveLength(0)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('revokes instead of promoting when the link is a password reset (address owner adopting via forgot-password)', async () => {
    verifyOtp.mockResolvedValue({ data: { user: pendingUser, session: {} }, error: null })

    const response = await GET(request('recovery', '/reset-password'))

    // The recovery flow itself is untouched.
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')

    const writes = identityWrites()
    expect(writes.map((c) => c.method)).toEqual([
      'select', 'eq', 'is', 'maybeSingle',
      'delete', 'eq', 'is',
    ])
    expect(writes[5].args).toEqual(['user_id', 'user-1'])
    expect(writes[6].args).toEqual(['email_verified_at', null])
    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { has_password: false, bankid_pending: null },
    })
    // Never the MFA exemption.
    const written = updateUserById.mock.calls[0][1].app_metadata as Record<string, unknown>
    expect(written.bankid_linked).toBeUndefined()
    // BankID instant login: the holder may hold sessions; they die with the
    // link. No session id could be read from the bare session here.
    expect(rpc).toHaveBeenCalledWith('revoke_user_sessions', {
      p_user_id: 'user-1',
      p_keep_session_id: null,
    })
  })

  it('keeps the address owner\'s own session when revoking (session_id claim of the fresh token)', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: pendingUser, session: { access_token: accessTokenWithSession('sess-owner') } },
      error: null,
    })

    await GET(request('recovery', '/reset-password'))

    expect(rpc).toHaveBeenCalledWith('revoke_user_sessions', {
      p_user_id: 'user-1',
      p_keep_session_id: 'sess-owner',
    })
  })

  it('revokes on a Google sign-in (PKCE code exchange), which is how the address owner adopts the account', async () => {
    // GoTrue auto-links the Google identity by verified e-mail; the pending
    // BankID link and the BankID holder's sessions must go, this exchange's
    // session must stay.
    exchangeCodeForSession.mockResolvedValue({
      data: {
        user: { ...pendingUser, identities: [{ provider: 'email' }, { provider: 'google' }] },
        session: { access_token: accessTokenWithSession('sess-google') },
      },
      error: null,
    })
    getUserById.mockResolvedValue({
      data: { user: { ...pendingUser, identities: [{ provider: 'email' }, { provider: 'google' }] } },
      error: null,
    })
    const url = new URL('http://localhost:3000/auth/callback')
    url.searchParams.set('code', 'pkce-code')

    await GET(new NextRequest(url))

    expect(identityWrites().map((c) => c.method)).toContain('delete')
    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { has_password: false, bankid_pending: null },
    })
    expect(rpc).toHaveBeenCalledWith('revoke_user_sessions', {
      p_user_id: 'user-1',
      p_keep_session_id: 'sess-google',
    })
  })

  it('never revokes sessions when promoting', async () => {
    verifyOtp.mockResolvedValue({ data: { user: pendingUser, session: {} }, error: null })

    await GET(request('magiclink'))

    expect(identityWrites().map((c) => c.method)).toContain('update')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('revokes when the account already carries a Google identity, even on a confirmation link', async () => {
    // The victim signed in with Google first; the BankID holder's stale
    // confirmation click must not attach their BankID to the victim's account.
    verifyOtp.mockResolvedValue({ data: { user: pendingUser, session: {} }, error: null })
    getUserById.mockResolvedValue({
      data: {
        user: {
          ...pendingUser,
          identities: [{ provider: 'email' }, { provider: 'google' }],
        },
      },
      error: null,
    })

    await GET(request('magiclink'))

    const writes = identityWrites()
    expect(writes.map((c) => c.method)).toContain('delete')
    expect(writes.map((c) => c.method)).not.toContain('update')
    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { has_password: false, bankid_pending: null },
    })
  })

  it('revokes when the user has set a password themselves', async () => {
    verifyOtp.mockResolvedValue({ data: { user: pendingUser, session: {} }, error: null })
    getUserById.mockResolvedValue({
      data: { user: { ...pendingUser, app_metadata: { bankid_pending: true, has_password: true } } },
      error: null,
    })

    await GET(request('magiclink'))

    expect(identityWrites().map((c) => c.method)).toContain('delete')
    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { has_password: true, bankid_pending: null },
    })
  })

  it('only clears the stale flag when no pending row is left', async () => {
    pendingLookup = { data: null, error: null }
    verifyOtp.mockResolvedValue({ data: { user: pendingUser, session: {} }, error: null })

    await GET(request('magiclink'))

    const methods = identityWrites().map((c) => c.method)
    expect(methods).not.toContain('delete')
    expect(methods).not.toContain('update')
    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { has_password: false, bankid_pending: null },
    })
  })

  it('leaves the identity pending (safe state) and still redirects when the promotion write fails', async () => {
    verifyOtp.mockResolvedValue({ data: { user: pendingUser, session: {} }, error: null })
    writeResult = { error: { message: 'boom' } }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await GET(request('magiclink'))

    expect(response.status).toBe(307)
    expect(updateUserById).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
