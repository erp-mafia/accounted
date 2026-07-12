import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const verifyOtp = vi.fn()
const exchangeCodeForSession = vi.fn()

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      verifyOtp,
      exchangeCodeForSession,
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null }),
        listFactors: vi.fn().mockResolvedValue({ data: null }),
      },
    },
    from: vi.fn(),
    rpc: vi.fn(),
  })),
}))

vi.mock('@/lib/auth/invite-tokens', () => ({
  hashInviteToken: vi.fn(),
}))

import { GET } from '../route'

describe('GET /auth/callback: recovery flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects to /reset-password after a successful recovery OTP (token-hash flow)', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=recovery&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc', type: 'recovery' })
  })

  it('redirects to /reset-password after a successful PKCE exchange when next=/reset-password (no type param)', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?code=xyz&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(exchangeCodeForSession).toHaveBeenCalledWith('xyz')
  })

  it('redirects to /login?error=auth_error when the recovery OTP is expired or already consumed', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=expired&type=recovery&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?error=auth_error')
  })
})
