import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  supabaseFactory: vi.fn(),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
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
  getActiveCompanyId: (...args: unknown[]) => mocks.getActiveCompanyId(...args),
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

const codeExchange = {
  grant_type: 'authorization_code',
  code: 'ciphertext',
  code_verifier: 'verifier',
  redirect_uri: 'https://claude.ai/api/cb',
}

/**
 * Query results in the order handleAuthorizationCodeGrant issues them:
 * used-code insert, expired-code cleanup, (role lookup when a company is
 * known), create_api_key_with_allowlist RPC. The role step is skipped for
 * companyless grants.
 */
function exchangeResults(role: { role: string } | null | 'skip' = { role: 'owner' }) {
  const results: { data?: unknown; error?: unknown }[] = [
    { data: null, error: null }, // insert into oauth_used_codes
    { data: null, error: null }, // delete expired codes (best-effort)
  ]
  if (role !== 'skip') results.push({ data: role, error: null }) // company_members role
  results.push({ data: 'key-9', error: null }) // create_api_key_with_allowlist RPC (new key id)
  return results
}

/**
 * Named arguments of the create_api_key_with_allowlist call: the key row and
 * its allowlist rows are one RPC, so this is where the minted key's shape is
 * asserted.
 */
function createKeyArgs(
  supabase: ReturnType<typeof createQueuedMockSupabase>['supabase'],
): Record<string, unknown> {
  const call = supabase.rpc.mock.calls.find((c) => c[0] === 'create_api_key_with_allowlist')
  expect(call).toBeDefined()
  return call![1] as Record<string, unknown>
}

describe('POST /api/mcp-oauth/token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
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
      enqueueMany(exchangeResults())

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.access_token).toMatch(/^gnubok_sk_/)
      expect(body.refresh_token).toMatch(/^gnubok_rt_/)
      expect(body.token_type).toBe('Bearer')
      expect(body.expires_in).toBe(3600)
    })

    it('mints an unbound key (company_id null) when the user has no company yet', async () => {
      // Signup inside the OAuth popup (issue #1814): the account exists, the
      // company does not. The key is stored unbound and validateApiKey binds
      // it on the first call after the company is created. No company means
      // no role to cap against: the consented scopes go through as-is.
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['companies:read', 'companies:write'],
        companyId: null,
        exp: Date.now() + 60_000,
      })
      vi.mocked(verifyPkce).mockReturnValue(true)
      mocks.getActiveCompanyId.mockResolvedValueOnce(null)

      const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults('skip'))

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.access_token).toMatch(/^gnubok_sk_/)
      expect(body.scope).toBe('companies:read companies:write')

      const created = createKeyArgs(supabase)
      expect(created.p_user_id).toBe('user-1')
      expect(created.p_company_id).toBeNull()
      expect(created.p_company_ids).toBeNull()
      expect(findCall('company_members', 'select')).toBeUndefined()
    })

    it('records which built-in client minted the key, from the redirect URI in the code', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        exp: Date.now() + 60_000,
      })
      vi.mocked(verifyPkce).mockReturnValue(true)

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults())

      const res = await POST(formRequest({ ...codeExchange, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect' }))
      expect(res.status).toBe(200)
      expect(createKeyArgs(supabase).p_client).toBe('chatgpt')
    })

    it('stores client null for a redirect URI that is not a built-in client', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://agent.testbrand.example/oauth/callback',
        exp: Date.now() + 60_000,
      })
      vi.mocked(verifyPkce).mockReturnValue(true)

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults())

      const res = await POST(formRequest({ ...codeExchange, redirect_uri: 'https://agent.testbrand.example/oauth/callback' }))
      expect(res.status).toBe(200)
      expect(createKeyArgs(supabase).p_client).toBeNull()
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

      const res = await POST(formRequest(codeExchange))
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

      const res = await POST(formRequest({ ...codeExchange, code_verifier: 'wrong' }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid_grant')
      expect(body.error_description).toContain('PKCE')
    })
  })

  describe('company binding and role cap', () => {
    beforeEach(() => {
      vi.mocked(verifyPkce).mockReturnValue(true)
    })

    it('binds the key to the company carried in the code instead of re-resolving the active company', async () => {
      // The consent page showed company-7 and capped the grant to the user's
      // role there; the key must land on that company, not on whatever the
      // user switched to in the meantime.
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['reports:read'],
        companyId: 'company-7',
        exp: Date.now() + 60_000,
      })

      const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults({ role: 'member' }))

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)

      expect(mocks.getActiveCompanyId).not.toHaveBeenCalled()
      expect(createKeyArgs(supabase).p_company_id).toBe('company-7')
      // The role lookup ran against that same company.
      const eqArgs = findCalls('company_members', 'eq')
      expect(eqArgs).toContainEqual(['company_id', 'company-7'])
      expect(eqArgs).toContainEqual(['user_id', 'user-1'])
    })

    it('viewer consent yields a read-only key even when the code carries write scopes', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['transactions:read', 'transactions:write', 'pending_operations:approve', 'reports:read'],
        companyId: 'company-1',
        exp: Date.now() + 60_000,
      })

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults({ role: 'viewer' }))

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.scope.split(' ').sort()).toEqual(['reports:read', 'transactions:read'])

      const created = createKeyArgs(supabase)
      expect(created.p_scopes).toEqual(['transactions:read', 'reports:read'])
      expect(created.p_sod_acknowledged_at).toBeNull()
      expect(created.p_sod_acknowledged_by).toBeNull()
    })

    it('viewer whose code carries only write scopes falls back to the read-only defaults', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['bookkeeping:write'],
        companyId: 'company-1',
        exp: Date.now() + 60_000,
      })

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults({ role: 'viewer' }))

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      const granted = (await res.json()).scope.split(' ')
      expect(granted).toContain('reports:read')
      expect(granted).not.toContain('bookkeeping:write')
      expect(granted.every((s: string) => s.endsWith(':read'))).toBe(true)
    })

    it('membership removed between consent and exchange caps to read-only', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['transactions:read', 'transactions:write'],
        companyId: 'company-1',
        exp: Date.now() + 60_000,
      })

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults(null))

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      expect((await res.json()).scope).toBe('transactions:read')
    })

    it('records the segregation-of-duties acknowledgement when stage and approve are both granted', async () => {
      // Mirrors app/api/settings/api-keys: the combination is allowed for a
      // writer role but leaves a durable self-attestation on the key row.
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['transactions:write', 'pending_operations:approve'],
        companyId: 'company-1',
        exp: Date.now() + 60_000,
      })

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults({ role: 'member' }))

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const res = await POST(formRequest(codeExchange))
      warn.mockRestore()
      expect(res.status).toBe(200)

      const created = createKeyArgs(supabase)
      expect(created.p_scopes).toEqual(['transactions:write', 'pending_operations:approve'])
      expect(typeof created.p_sod_acknowledged_at).toBe('string')
      expect(created.p_sod_acknowledged_by).toBe('user-1')
    })

    it('records no acknowledgement for a non-conflicting grant', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['transactions:write', 'pending_operations:read'],
        companyId: 'company-1',
        exp: Date.now() + 60_000,
      })

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults({ role: 'owner' }))

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      expect(createKeyArgs(supabase).p_sod_acknowledged_at).toBeNull()
    })

    it('returns 500 and mints no key when the role lookup fails', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['transactions:read'],
        companyId: 'company-1',
        exp: Date.now() + 60_000,
      })

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany([
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: { message: 'connection reset' } },
      ])

      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = await POST(formRequest(codeExchange))
      error.mockRestore()
      expect(res.status).toBe(500)
      expect((await res.json()).error).toBe('server_error')
      expect(supabase.rpc).not.toHaveBeenCalled()
    })
  })

  describe('company allowlist (per-key company scoping)', () => {
    const A = '11111111-1111-4111-8111-111111111111'
    const B = '22222222-2222-4222-8222-222222222222'

    beforeEach(() => {
      vi.mocked(verifyPkce).mockReturnValue(true)
    })

    function codeWith(companyId: string | null, companyIds: unknown) {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['reports:read'],
        companyId,
        companyIds: companyIds as string[] | null,
        exp: Date.now() + 60_000,
      })
    }

    it('passes the consented companies to the RPC so key and allowlist rows are one transaction', async () => {
      codeWith(A, [A, B])
      const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany([
        { data: null, error: null }, // oauth_used_codes insert
        { data: null, error: null }, // expired-code cleanup
        { data: { role: 'owner' }, error: null }, // role lookup in the default company
        { data: 'key-9', error: null }, // create_api_key_with_allowlist RPC
      ])

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)

      expect(supabase.rpc).toHaveBeenCalledTimes(1)
      const created = createKeyArgs(supabase)
      expect(created.p_company_id).toBe(A)
      expect(created.p_company_ids).toEqual([A, B])
      expect(created.p_name).toBe('MCP-klient (OAuth)')
      expect(created.p_mode).toBeNull()
      expect(created.p_unattended_commit_limit).toBeNull()
      expect(typeof created.p_refresh_token_hash).toBe('string')
      // Never a separate allowlist insert, never a compensating revoke.
      expect(findCall('api_key_companies', 'insert')).toBeUndefined()
      expect(findCall('api_keys', 'insert')).toBeUndefined()
      expect(findCall('api_keys', 'update')).toBeUndefined()
    })

    it('falls back to the first allowed company as default when the consented one is outside the allowlist', async () => {
      // /authorize guarantees the default sits inside the selection; the
      // code is still a hostile boundary, so a default outside it is fixed
      // here rather than trusted.
      codeWith('company-elsewhere', [B])
      const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany([
        { data: null, error: null },
        { data: null, error: null },
        { data: { role: 'owner' }, error: null },
        { data: 'key-9', error: null },
      ])

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      const created = createKeyArgs(supabase)
      expect(created.p_company_id).toBe(B)
      expect(created.p_company_ids).toEqual([B])
      // The role cap ran against the effective default, not the stale one.
      expect(findCalls('company_members', 'eq')).toContainEqual(['company_id', B])
      expect(mocks.getActiveCompanyId).not.toHaveBeenCalled()
    })

    it('answers server_error and hands out no key when the RPC fails', async () => {
      // One transaction: a refused allowlist (or any failure) leaves no key
      // row behind, so there is nothing to revoke and nothing to return.
      codeWith(A, [A, B])
      const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany([
        { data: null, error: null },
        { data: null, error: null },
        { data: { role: 'owner' }, error: null },
        { data: null, error: { code: '42501', message: 'user is not a live member of company' } }, // RPC
      ])

      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = await POST(formRequest(codeExchange))
      error.mockRestore()

      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('server_error')
      expect(body.access_token).toBeUndefined()
      expect(body.refresh_token).toBeUndefined()

      // No compensation path: nothing was written outside the transaction.
      expect(findCall('api_keys', 'update')).toBeUndefined()
      expect(findCall('api_keys', 'insert')).toBeUndefined()
      expect(findCall('api_key_companies', 'insert')).toBeUndefined()
    })

    it('passes null for an unrestricted consent (companyIds null)', async () => {
      codeWith(A, null)
      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults({ role: 'owner' }))

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      const created = createKeyArgs(supabase)
      expect(created.p_company_ids).toBeNull()
      expect(created.p_company_id).toBe(A)
    })

    it('treats an allowlist with no uuid-shaped entries as unrestricted rather than as no company', async () => {
      codeWith(A, ['nope', 42])
      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults({ role: 'owner' }))

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      expect(createKeyArgs(supabase).p_company_ids).toBeNull()
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
      enqueueMany(exchangeResults())

      const res = await POST(formRequest(codeExchange))
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
      enqueueMany(exchangeResults())

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.scope).toBe('transactions:read invoices:read')
    })

    it('keeps an owner grant with write scopes intact (no cap for writer roles)', async () => {
      vi.mocked(decryptAuthCode).mockReturnValue({
        userId: 'user-1',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/cb',
        scopes: ['transactions:read', 'transactions:write', 'bookkeeping:write'],
        companyId: 'company-1',
        exp: Date.now() + 60_000,
      })
      vi.mocked(verifyPkce).mockReturnValue(true)

      const { supabase, enqueueMany } = createQueuedMockSupabase()
      mocks.supabaseFactory.mockReturnValue(supabase)
      enqueueMany(exchangeResults({ role: 'owner' }))

      const res = await POST(formRequest(codeExchange))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.scope).toBe('transactions:read transactions:write bookkeeping:write')
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

      const res = await POST(formRequest(codeExchange))
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
