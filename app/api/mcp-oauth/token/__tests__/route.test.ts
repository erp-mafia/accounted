import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  supabaseFactory: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    createServiceClientNoCookies: () => mocks.supabaseFactory(),
  }
})

vi.mock('@/lib/auth/oauth-codes', () => ({
  decryptAuthCode: vi.fn(),
  verifyPkce: vi.fn(),
  hashAuthCode: vi.fn(() => 'auth-code-hash'),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { POST } from '../route'
import { decryptAuthCode, verifyPkce } from '@/lib/auth/oauth-codes'
import { generateRefreshToken } from '@/lib/auth/api-keys'

function formRequest(body: Record<string, string>) {
  return new Request('http://localhost/api/mcp-oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
}

describe('POST /api/mcp-oauth/token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('grant_type validation', () => {
    it('rejects unknown grant types', async () => {
      const res = await POST(formRequest({ grant_type: 'password' }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('unsupported_grant_type')
    })

    it('rejects unsupported content type', async () => {
      const req = new Request('http://localhost/api/mcp-oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'grant_type=authorization_code',
      })
      const res = await POST(req)
      expect(res.status).toBe(400)
    })
  })

  describe('authorization_code grant', () => {
    it('returns access_token, refresh_token, and expires_in on success', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        exp: Date.now() + 60_000,
      })
      vi.mocked(verifyPkce).mockReturnValue(true)

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany([
        { data: null, error: null }, // insert into oauth_used_codes
        { data: null, error: null }, // delete expired codes (best-effort)
        { data: null, error: null }, // insert into api_keys
      ])

      const res = await POST(
        formRequest({
          grant_type: 'authorization_code',
          code: 'ciphertext',
          code_verifier: 'verifier',
          redirect_uri: 'https://claude.ai/api/cb',
        })
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.access_token).toMatch(/^gnubok_sk_/)
      expect(body.refresh_token).toMatch(/^gnubok_rt_/)
      expect(body.token_type).toBe('Bearer')
      expect(body.expires_in).toBe(3600)
    })

    it('rejects an already-used auth code (replay)', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        exp: Date.now() + 60_000,
      })
      vi.mocked(verifyPkce).mockReturnValue(true)

      const { supabase, enqueue } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueue({ data: null, error: { message: 'unique violation' } })

      const res = await POST(
        formRequest({
          grant_type: 'authorization_code',
          code: 'ciphertext',
          code_verifier: 'verifier',
          redirect_uri: 'https://claude.ai/api/cb',
        })
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid_grant')
    })

    it('rejects when PKCE verification fails', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        exp: Date.now() + 60_000,
      })
      vi.mocked(verifyPkce).mockReturnValue(false)

      const res = await POST(
        formRequest({
          grant_type: 'authorization_code',
          code: 'ciphertext',
          code_verifier: 'wrong',
          redirect_uri: 'https://claude.ai/api/cb',
        })
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid_grant')
      expect(body.error_description).toContain('PKCE')
    })
  })

  describe('refresh_token grant', () => {
    it('rotates both tokens and returns a fresh access_token', async () => {
      const { token: refreshToken } = generateRefreshToken()

      const { supabase, enqueue } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      // rotate_mcp_refresh_token RPC → normal rotation
      enqueue({ data: [{ outcome: 'rotated', scopes: null }], error: null })

      const res = await POST(
        formRequest({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        })
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.access_token).toMatch(/^gnubok_sk_/)
      expect(body.refresh_token).toMatch(/^gnubok_rt_/)
      expect(body.refresh_token).not.toBe(refreshToken) // rotated
      expect(body.expires_in).toBe(3600)
    })

    it('returns 400 when refresh_token is missing', async () => {
      const res = await POST(formRequest({ grant_type: 'refresh_token' }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid_request')
    })

    it('returns 400 when refresh_token is unknown', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueue({ data: [{ outcome: 'invalid', scopes: null }], error: null })

      const res = await POST(
        formRequest({
          grant_type: 'refresh_token',
          refresh_token: 'gnubok_rt_unknown',
        })
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid_grant')
    })

    it('returns 400 when the api_key is revoked', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueue({ data: [{ outcome: 'revoked', scopes: null }], error: null })

      const res = await POST(
        formRequest({
          grant_type: 'refresh_token',
          refresh_token: 'gnubok_rt_anything',
        })
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid_grant')
      expect(body.error_description).toContain('revoked')
    })

    it('returns 500 when the rotation RPC fails with a DB error', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueue({ data: null, error: { message: 'connection reset' } })

      const res = await POST(
        formRequest({
          grant_type: 'refresh_token',
          refresh_token: 'gnubok_rt_anything',
        })
      )
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('server_error')
    })

    it('returns 400 invalid_grant when a refresh token is reused after its grace window (reuse_revoked)', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      // The RPC detected reuse of a previous refresh token past its grace
      // window and already revoked the grant family (RFC 9700 §4.14.2).
      enqueue({ data: [{ outcome: 'reuse_revoked', scopes: null }], error: null })

      const res = await POST(
        formRequest({
          grant_type: 'refresh_token',
          refresh_token: 'gnubok_rt_anything',
        })
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid_grant')
    })

    it('returns a fresh pair on idempotent in-grace replay instead of 400 (issue #710 regression)', async () => {
      // A retried / mis-persisted / concurrent refresh presents the previous
      // refresh token within the grace window. The old code returned 400
      // "already used", stranding Claude Code into a re-auth loop; the RPC now
      // replays idempotently and the client gets a working pair.
      const { supabase, enqueue } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueue({ data: [{ outcome: 'replayed', scopes: ['transactions:read'] }], error: null })

      const res = await POST(
        formRequest({
          grant_type: 'refresh_token',
          refresh_token: 'gnubok_rt_anything',
        })
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.access_token).toMatch(/^gnubok_sk_/)
      expect(body.refresh_token).toMatch(/^gnubok_rt_/)
      expect(body.expires_in).toBe(3600)
      expect(body.scope).toBe('transactions:read')
    })
  })

  describe('scope plumbing', () => {
    it('falls back to read-only DEFAULT_OAUTH_SCOPES when the auth code carries no scopes', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        exp: Date.now() + 60_000,
      })
      vi.mocked(verifyPkce).mockReturnValue(true)

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany([
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ])

      const res = await POST(
        formRequest({
          grant_type: 'authorization_code',
          code: 'ciphertext',
          code_verifier: 'verifier',
          redirect_uri: 'https://claude.ai/api/cb',
        })
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      // DEFAULT_OAUTH_SCOPES is read-only by design. Write and approval scopes
      // must be requested explicitly by the client AND ticked by the user on
      // the consent screen, GDPR Art. 25(2), ISO 27001:2022 A.5.18 / A.8.2,
      // SOC 2 CC6.3, ASVS V8.1.1 / V10.2.1.
      const granted = body.scope.split(' ')
      expect(granted).toContain('transactions:read')
      expect(granted).toContain('invoices:read')
      expect(granted).toContain('suppliers:read')
      expect(granted).toContain('reports:read')
      // No silent write or approval grants:
      expect(granted).not.toContain('transactions:write')
      expect(granted).not.toContain('invoices:write')
      expect(granted).not.toContain('suppliers:write')
      expect(granted).not.toContain('customers:write')
      expect(granted).not.toContain('documents:write')
      expect(granted).not.toContain('pending_operations:approve')
      expect(granted).not.toContain('bookkeeping:write')
      expect(granted).not.toContain('payroll:write')
      expect(granted).not.toContain('webhooks:manage')
    })

    it('honours scopes from the auth code when present', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['transactions:read', 'invoices:read'],
        exp: Date.now() + 60_000,
      })
      vi.mocked(verifyPkce).mockReturnValue(true)

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany([
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ])

      const res = await POST(
        formRequest({
          grant_type: 'authorization_code',
          code: 'ciphertext',
          code_verifier: 'verifier',
          redirect_uri: 'https://claude.ai/api/cb',
        })
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.scope).toBe('transactions:read invoices:read')
    })

    it('rejects a code whose embedded scopes are all unknown', async () => {
      // V9.2.1 defense-in-depth: even though /authorize already filters
      // unknown scopes, the token endpoint must not silently mint a
      // key with empty scopes: the auth code payload boundary is
      // treated as hostile.
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['unknown:scope', 'definitely:not:real'] as unknown as string[],
        exp: Date.now() + 60_000,
      })
      vi.mocked(verifyPkce).mockReturnValue(true)

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany([
        { data: null, error: null }, // insert into oauth_used_codes
        { data: null, error: null }, // delete expired codes
      ])

      const res = await POST(
        formRequest({
          grant_type: 'authorization_code',
          code: 'ciphertext',
          code_verifier: 'verifier',
          redirect_uri: 'https://claude.ai/api/cb',
        })
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid_grant')
    })
  })

  describe('refresh_token scope response', () => {
    it('returns the granular scopes the api_key was minted with', async () => {
      // Greptile P1: refresh response previously hardcoded scope:'mcp',
      // causing OAuth 2.1 clients to think they had lost their grant.
      const { supabase, enqueue } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueue({
        data: [
          {
            outcome: 'rotated',
            scopes: ['transactions:read', 'invoices:read', 'invoices:write'],
          },
        ],
        error: null,
      })

      const res = await POST(
        formRequest({
          grant_type: 'refresh_token',
          refresh_token: 'gnubok_rt_anything',
        })
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.scope.split(' ').sort()).toEqual(
        ['transactions:read', 'invoices:read', 'invoices:write'].sort()
      )
    })

    it('falls back to read-only DEFAULT_OAUTH_SCOPES for legacy keys with null scopes', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueue({ data: [{ outcome: 'rotated', scopes: null }], error: null })

      const res = await POST(
        formRequest({
          grant_type: 'refresh_token',
          refresh_token: 'gnubok_rt_anything',
        })
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      const granted = body.scope.split(' ')
      expect(granted).toContain('transactions:read')
      // No silent grant of write or approval scopes (GDPR Art. 25(2),
      // SoD per findStageApproveConflict, see lib/auth/api-keys.ts).
      expect(granted).not.toContain('transactions:write')
      expect(granted).not.toContain('pending_operations:approve')
      expect(granted).not.toContain('bookkeeping:write')
      expect(granted).not.toContain('payroll:write')
    })
  })
})
