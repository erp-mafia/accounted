/**
 * Password-grant session mint for pending BankID accounts: rotates the
 * random server-side password, marks the address confirmed on the GoTrue
 * side (the grant refuses otherwise), and exchanges the password through a
 * throwaway anon client. Never a magic link: that would void the
 * verification mail in flight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const signInWithPassword = vi.fn()
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: vi.fn(() => ({ auth: { signInWithPassword } })),
}))

import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { mintPendingSession, signupRequiresMailConfirmation } from '../lib/bankid-session-grant'

function service() {
  const admin = {
    updateUserById: vi.fn().mockResolvedValue({ data: {}, error: null }),
    generateLink: vi.fn(),
  }
  return { admin, client: { auth: { admin } } as never }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  signInWithPassword.mockResolvedValue({
    data: { session: { access_token: 'at', refresh_token: 'rt' } },
    error: null,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('signupRequiresMailConfirmation', () => {
  it('is off by default and on only with the rollback flag', () => {
    vi.stubEnv('BANKID_SIGNUP_REQUIRE_EMAIL_CONFIRMATION', '')
    expect(signupRequiresMailConfirmation()).toBe(false)
    vi.stubEnv('BANKID_SIGNUP_REQUIRE_EMAIL_CONFIRMATION', 'true')
    expect(signupRequiresMailConfirmation()).toBe(true)
  })
})

describe('mintPendingSession', () => {
  it('rotates the password, confirms the address for GoTrue, and returns the granted tokens', async () => {
    const { admin, client } = service()

    const result = await mintPendingSession(client, 'user-1', 'typed@example.com')

    expect(result).toEqual({ ok: true, session: { accessToken: 'at', refreshToken: 'rt' } })
    const [userId, patch] = admin.updateUserById.mock.calls[0] as [string, { password: string; email_confirm: boolean }]
    expect(userId).toBe('user-1')
    expect(patch.email_confirm).toBe(true)
    expect(patch.password.length).toBeGreaterThanOrEqual(40)
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'typed@example.com', password: patch.password })
    // The grant runs on a throwaway anon-key client from the leak-safe
    // factory (persistSession/autoRefreshToken pinned off there).
    expect(vi.mocked(createServiceRoleClient)).toHaveBeenCalledWith(
      'https://x.supabase.co',
      'anon-key',
      expect.objectContaining({ auth: expect.objectContaining({ detectSessionInUrl: false }) }),
    )
    expect(admin.generateLink).not.toHaveBeenCalled()
  })

  it('fails before the grant when the password cannot be rotated', async () => {
    const { admin, client } = service()
    admin.updateUserById.mockResolvedValueOnce({ data: null, error: { code: 'x', message: 'boom' } })

    const result = await mintPendingSession(client, 'user-1', 'typed@example.com')

    expect(result).toEqual({ ok: false, step: 'rotate_password', message: 'boom' })
    expect(signInWithPassword).not.toHaveBeenCalled()
  })

  it('reports a refused grant', async () => {
    const { client } = service()
    signInWithPassword.mockResolvedValueOnce({ data: { session: null }, error: { code: 'invalid_credentials', message: 'nope' } })

    const result = await mintPendingSession(client, 'user-1', 'typed@example.com')

    expect(result).toEqual({ ok: false, step: 'password_grant', message: 'nope' })
  })
})
