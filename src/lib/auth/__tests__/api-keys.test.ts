import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

const contextMocks = vi.hoisted(() => ({
  getActiveCompanyId: vi.fn(),
}))

vi.mock('@/lib/company/active-company', () => ({
  getActiveCompanyId: (...args: unknown[]) => contextMocks.getActiveCompanyId(...args),
}))

import {
  generateApiKey,
  hashApiKey,
  hashRefreshToken,
  deriveRotatedCredentials,
  extractBearerToken,
  validateScopes,
  hasScope,
  validateApiKey,
  credentialActor,
  OAUTH_MCP_KEY_NAME,
  findStageApproveConflict,
  DEFAULT_SCOPES,
  DEFAULT_OAUTH_SCOPES,
  STAGING_SCOPES,
  TOOL_SCOPE_MAP,
  API_KEY_SCOPES,
} from '../api-keys'
import { createClient } from '@supabase/supabase-js'

const mockCreateClient = vi.mocked(createClient)

beforeEach(() => {
  vi.clearAllMocks()
})

// ============================================================
// generateApiKey
// ============================================================

describe('generateApiKey', () => {
  it('returns key starting with "gnubok_sk_"', () => {
    const { key } = generateApiKey()
    expect(key.startsWith('gnubok_sk_')).toBe(true)
  })

  it('returns 64-char hex SHA-256 hash', () => {
    const { hash } = generateApiKey()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns prefix of KEY_PREFIX + 8 chars', () => {
    const { key, prefix } = generateApiKey()
    expect(prefix).toBe(key.slice(0, 'gnubok_sk_'.length + 8))
  })

  it('generates unique keys on successive calls', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.key).not.toBe(b.key)
    expect(a.hash).not.toBe(b.hash)
  })

  it('hash matches hashApiKey(key)', () => {
    const { key, hash } = generateApiKey()
    expect(hashApiKey(key)).toBe(hash)
  })
})

// ============================================================
// hashApiKey
// ============================================================

describe('hashApiKey', () => {
  it('returns 64-char hex string', () => {
    const hash = hashApiKey('gnubok_sk_test-key')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for same input', () => {
    const hash1 = hashApiKey('gnubok_sk_deterministic')
    const hash2 = hashApiKey('gnubok_sk_deterministic')
    expect(hash1).toBe(hash2)
  })

  it('produces different hashes for different inputs', () => {
    const hash1 = hashApiKey('gnubok_sk_key-a')
    const hash2 = hashApiKey('gnubok_sk_key-b')
    expect(hash1).not.toBe(hash2)
  })
})

// ============================================================
// deriveRotatedCredentials (crm#1043)
// ============================================================

describe('deriveRotatedCredentials', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-secret')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rotates the same refresh token into the same pair every time', () => {
    const a = deriveRotatedCredentials('gnubok_rt_presented')
    const b = deriveRotatedCredentials('gnubok_rt_presented')
    expect(b).toEqual(a)
  })

  it('returns well-formed tokens whose hashes are what the database stores', () => {
    const { refresh, key } = deriveRotatedCredentials('gnubok_rt_presented')
    expect(refresh.token).toMatch(/^gnubok_rt_[A-Za-z0-9_-]{43}$/)
    expect(key.key).toMatch(/^gnubok_sk_[A-Za-z0-9_-]{43}$/)
    expect(refresh.hash).toBe(hashRefreshToken(refresh.token))
    expect(key.hash).toBe(hashApiKey(key.key))
    expect(key.prefix).toBe(key.key.slice(0, 'gnubok_sk_'.length + 8))
  })

  it('gives different tokens a different successor, and never the token itself', () => {
    const a = deriveRotatedCredentials('gnubok_rt_one')
    const b = deriveRotatedCredentials('gnubok_rt_two')
    expect(a.refresh.token).not.toBe(b.refresh.token)
    expect(a.key.key).not.toBe(b.key.key)
    expect(a.refresh.token).not.toBe('gnubok_rt_one')
    // Access key and refresh token are independent derivations.
    expect(a.key.key.slice('gnubok_sk_'.length)).not.toBe(a.refresh.token.slice('gnubok_rt_'.length))
  })

  it('cannot be computed without the server secret', () => {
    const withSecret = deriveRotatedCredentials('gnubok_rt_presented')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'another-secret')
    expect(deriveRotatedCredentials('gnubok_rt_presented').refresh.token).not.toBe(withSecret.refresh.token)
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    expect(() => deriveRotatedCredentials('gnubok_rt_presented')).toThrow('SUPABASE_SERVICE_ROLE_KEY')
  })
})

// ============================================================
// extractBearerToken
// ============================================================

describe('extractBearerToken', () => {
  it('extracts token from valid Bearer header', () => {
    const request = new Request('http://localhost', {
      headers: { authorization: 'Bearer my-secret-token' },
    })
    expect(extractBearerToken(request)).toBe('my-secret-token')
  })

  it('returns null when no authorization header', () => {
    const request = new Request('http://localhost')
    expect(extractBearerToken(request)).toBeNull()
  })

  it('returns null when header is not Bearer scheme', () => {
    const request = new Request('http://localhost', {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(extractBearerToken(request)).toBeNull()
  })

  it('handles token with special characters', () => {
    const request = new Request('http://localhost', {
      headers: { authorization: 'Bearer gnubok_sk_abc+def/ghi=jkl' },
    })
    expect(extractBearerToken(request)).toBe('gnubok_sk_abc+def/ghi=jkl')
  })
})

// ============================================================
// validateScopes
// ============================================================

describe('validateScopes', () => {
  it('returns null for null input', () => {
    expect(validateScopes(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(validateScopes(undefined)).toBeNull()
  })

  it('returns null for non-array input', () => {
    expect(validateScopes('transactions:read')).toBeNull()
    expect(validateScopes(42)).toBeNull()
    expect(validateScopes({ scope: 'transactions:read' })).toBeNull()
  })

  it('filters to only valid API_KEY_SCOPES', () => {
    const result = validateScopes(['transactions:read', 'invalid:scope', 'reports:read'])
    expect(result).toEqual(['transactions:read', 'reports:read'])
  })

  it('returns null when no valid scopes remain after filter', () => {
    expect(validateScopes(['invalid:scope', 'also:invalid'])).toBeNull()
  })

  it('preserves valid scopes from mixed input', () => {
    const result = validateScopes(['customers:write', 'bogus', 'invoices:read'])
    expect(result).toEqual(['customers:write', 'invoices:read'])
  })
})

// ============================================================
// hasScope
// ============================================================

describe('hasScope', () => {
  it('returns true when scope present in array', () => {
    expect(hasScope(['transactions:read', 'reports:read'], 'transactions:read')).toBe(true)
  })

  it('returns false when scope absent', () => {
    expect(hasScope(['transactions:read', 'reports:read'], 'invoices:write')).toBe(false)
  })
})

// ============================================================
// findStageApproveConflict
// ============================================================

describe('findStageApproveConflict', () => {
  it('returns null when approve scope is absent', () => {
    expect(findStageApproveConflict(['invoices:write', 'reports:read'])).toBeNull()
  })

  it('returns null when approve scope present but no staging scope', () => {
    expect(
      findStageApproveConflict(['pending_operations:approve', 'reports:read']),
    ).toBeNull()
  })

  it('returns the offending staging scope when both are present', () => {
    expect(
      findStageApproveConflict(['invoices:write', 'pending_operations:approve']),
    ).toBe('invoices:write')
  })

  it('treats every STAGING_SCOPES member as a conflict alongside approve', () => {
    for (const staging of STAGING_SCOPES) {
      expect(findStageApproveConflict([staging, 'pending_operations:approve'])).toBe(staging)
    }
  })

  it('does NOT treat agent:write as a staging scope', () => {
    expect(STAGING_SCOPES).not.toContain('agent:write')
    // agent:write + approve is not a SoD conflict: memory writes don't stage
    // bookkeeping that approve would commit.
    expect(
      findStageApproveConflict(['agent:write', 'pending_operations:approve']),
    ).toBeNull()
  })
})

// ============================================================
// agent:write scope wiring
// ============================================================

describe('agent:write scope', () => {
  it('is a registered scope with a Swedish label and description', () => {
    expect(API_KEY_SCOPES['agent:write']).toBeDefined()
    expect(API_KEY_SCOPES['agent:write'].label).toBe('Agent: skriv')
    expect(typeof API_KEY_SCOPES['agent:write'].description).toBe('string')
  })

  it('maps the memory write tools to agent:write', () => {
    expect(TOOL_SCOPE_MAP.gnubok_remember_fact).toBe('agent:write')
    expect(TOOL_SCOPE_MAP.gnubok_forget_fact).toBe('agent:write')
  })

  it('keeps gnubok_get_agent_briefing on agent:read', () => {
    expect(TOOL_SCOPE_MAP.gnubok_get_agent_briefing).toBe('agent:read')
  })

  it('is excluded from the default scope grants', () => {
    expect(DEFAULT_SCOPES).not.toContain('agent:write')
    expect(DEFAULT_OAUTH_SCOPES).not.toContain('agent:write')
  })
})

// ============================================================
// validateApiKey
// ============================================================

describe('validateApiKey', () => {
  function setupMockRpc(response: { data: unknown; error: unknown }) {
    const mockRpc = vi.fn().mockResolvedValue(response)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockReturnValue({ rpc: mockRpc } as any)
  }

  it('rejects keys not starting with "gnubok_sk_"', async () => {
    const result = await validateApiKey('invalid-key-format')
    expect(result).toEqual({ error: 'Invalid API key format', status: 401 })
  })

  it('rejects a refresh token presented as Bearer with a specific message', async () => {
    const result = await validateApiKey('gnubok_rt_some_refresh_token')
    expect('status' in result && result.status).toBe(401)
    expect('error' in result && result.error).toContain('Refresh token')
  })

  it('rejects when RPC returns error', async () => {
    setupMockRpc({ data: null, error: { message: 'db error' } })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({ error: 'Invalid API key', status: 401 })
  })

  it('rejects when RPC returns empty data array', async () => {
    setupMockRpc({ data: [], error: null })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({ error: 'Invalid API key', status: 401 })
  })

  it('returns rate limit error when rate_limited is true', async () => {
    setupMockRpc({
      data: [{ user_id: 'u1', company_id: 'c1', scopes: null, rate_limited: true }],
      error: null,
    })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({ error: 'Rate limit exceeded', status: 429 })
  })

  it('returns userId, companyId, scopes on success', async () => {
    setupMockRpc({
      data: [{
        user_id: 'user-123',
        company_id: 'company-456',
        scopes: ['transactions:read', 'reports:read'],
        rate_limited: false,
      }],
      error: null,
    })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({
      userId: 'user-123',
      companyId: 'company-456',
      apiKeyId: undefined,
      apiKeyName: undefined,
      scopes: ['transactions:read', 'reports:read'],
      mode: 'live',
      unattendedCommitLimit: null,
      allowedCompanyIds: null,
      readOnlyCompanyIds: null,
      serviceAccount: null,
      agentIdentityId: null,
      client: null,
      clientName: null,
    })
  })

  it('falls back to DEFAULT_SCOPES when row.scopes is null', async () => {
    setupMockRpc({
      data: [{
        user_id: 'user-123',
        company_id: 'company-456',
        scopes: null,
        rate_limited: false,
      }],
      error: null,
    })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({
      userId: 'user-123',
      companyId: 'company-456',
      apiKeyId: undefined,
      apiKeyName: undefined,
      scopes: DEFAULT_SCOPES,
      mode: 'live',
      unattendedCommitLimit: null,
      allowedCompanyIds: null,
      readOnlyCompanyIds: null,
      serviceAccount: null,
      agentIdentityId: null,
      client: null,
      clientName: null,
    })
  })

  it('surfaces mode from the RPC row', async () => {
    setupMockRpc({
      data: [{
        user_id: 'user-123',
        company_id: 'company-456',
        api_key_id: 'ak_1',
        api_key_name: 'CI test key',
        scopes: ['transactions:read'],
        rate_limited: false,
        mode: 'test',
      }],
      error: null,
    })

    const result = await validateApiKey('gnubok_sk_test-key-value')
    expect(result).toEqual({
      userId: 'user-123',
      companyId: 'company-456',
      apiKeyId: 'ak_1',
      apiKeyName: 'CI test key',
      scopes: ['transactions:read'],
      mode: 'test',
      unattendedCommitLimit: null,
      allowedCompanyIds: null,
      readOnlyCompanyIds: null,
      serviceAccount: null,
      agentIdentityId: null,
      client: null,
      clientName: null,
    })
  })

  describe('agent identities', () => {
    it('returns the agent identity and the client the key belongs to', async () => {
      setupMockRpc({
        data: [{
          user_id: 'user-1',
          company_id: 'company-1',
          api_key_id: 'ak_oauth',
          api_key_name: 'MCP-klient (OAuth)',
          scopes: ['transactions:read'],
          rate_limited: false,
          agent_identity_id: 'identity-1',
          client: 'claude',
        }],
        error: null,
      })

      expect(await validateApiKey('gnubok_sk_test-key-value')).toMatchObject({
        userId: 'user-1',
        agentIdentityId: 'identity-1',
        client: 'claude',
      })
    })

    it('answers a paused agent 403 AGENT_PAUSED, not the bare 401', async () => {
      const mockRpc = vi.fn(async (name: string) =>
        name === 'api_key_refusal' ? { data: 'AGENT_PAUSED', error: null } : { data: [], error: null },
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockCreateClient.mockReturnValue({ rpc: mockRpc } as any)

      const result = await validateApiKey('gnubok_sk_test-key-value')
      expect(result).toEqual({ error: expect.stringMatching(/paused/i), status: 403, code: 'AGENT_PAUSED' })
    })

    it('ignores a refusal code it does not know: the bare 401', async () => {
      const mockRpc = vi.fn(async (name: string) =>
        name === 'api_key_refusal' ? { data: 'SOMETHING_NEW', error: null } : { data: [], error: null },
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockCreateClient.mockReturnValue({ rpc: mockRpc } as any)

      expect(await validateApiKey('gnubok_sk_test-key-value')).toEqual({ error: 'Invalid API key', status: 401 })
    })
  })

  describe('service accounts', () => {
    it('returns the service account the key belongs to', async () => {
      setupMockRpc({
        data: [{
          user_id: 'sponsor-1',
          company_id: 'company-456',
          api_key_id: 'ak_sa',
          api_key_name: 'Nyckel 1',
          scopes: ['invoices:read'],
          rate_limited: false,
          allowed_company_ids: ['company-456'],
          read_only_company_ids: null,
          service_account_id: 'sa-1',
          service_account_name: 'Nattlig fakturasynk',
        }],
        error: null,
      })

      const result = await validateApiKey('gnubok_sk_test-key-value')
      expect(result).toMatchObject({
        userId: 'sponsor-1',
        allowedCompanyIds: ['company-456'],
        serviceAccount: { id: 'sa-1', name: 'Nattlig fakturasynk' },
      })
    })

    it('answers a suspended service account with its own code, not the bare 401', async () => {
      const mockRpc = vi.fn(async (name: string) =>
        name === 'api_key_refusal'
          ? { data: 'SERVICE_ACCOUNT_SUSPENDED', error: null }
          : { data: [], error: null },
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockCreateClient.mockReturnValue({ rpc: mockRpc } as any)

      const result = await validateApiKey('gnubok_sk_test-key-value')
      expect(result).toMatchObject({ status: 403, code: 'SERVICE_ACCOUNT_SUSPENDED' })
      expect(mockRpc).toHaveBeenCalledWith('api_key_refusal', { p_key_hash: expect.any(String) })
    })

    it('falls back to the bare 401 when the refusal lookup fails (a DB without the function)', async () => {
      const mockRpc = vi.fn(async (name: string) =>
        name === 'api_key_refusal'
          ? { data: null, error: { code: 'PGRST202', message: 'not found' } }
          : { data: [], error: null },
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockCreateClient.mockReturnValue({ rpc: mockRpc } as any)

      expect(await validateApiKey('gnubok_sk_test-key-value')).toEqual({ error: 'Invalid API key', status: 401 })
    })

    it('does not look up a refusal when the validation itself failed', async () => {
      const mockRpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'db error' } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockCreateClient.mockReturnValue({ rpc: mockRpc } as any)

      expect(await validateApiKey('gnubok_sk_test-key-value')).toEqual({ error: 'Invalid API key', status: 401 })
      expect(mockRpc).toHaveBeenCalledTimes(1)
    })

    it('names the actor service_account for a service account key, api_key otherwise', () => {
      expect(credentialActor({ apiKeyName: 'Nyckel 1', serviceAccount: { id: 'sa-1', name: 'Synk' } })).toEqual({
        type: 'service_account',
        label: 'Synk',
      })
      expect(credentialActor({ apiKeyName: 'Nyckel 1', serviceAccount: null })).toEqual({
        type: 'api_key',
        label: 'Nyckel 1',
      })
      expect(credentialActor({ serviceAccount: null })).toEqual({ type: 'api_key', label: 'Unnamed API key' })
    })

    it("reads a registered client's own name once, for the records", async () => {
      const client = 'registered:11111111-1111-4111-8111-111111111111'
      const maybeSingle = vi.fn().mockResolvedValue({ data: { client_name: 'Egen klient' }, error: null })
      const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }))
      const rpc = vi.fn().mockResolvedValue({
        data: [{ user_id: 'user-123', company_id: 'company-456', api_key_name: OAUTH_MCP_KEY_NAME, rate_limited: false, client }],
        error: null,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockCreateClient.mockReturnValue({ rpc, from } as any)

      const result = await validateApiKey('gnubok_sk_test-key-value')

      expect(result).toMatchObject({ client, clientName: 'Egen klient (registered client)' })
      expect(from).toHaveBeenCalledWith('oauth_client_registrations')
    })

    it('does not look a built-in client up', async () => {
      const from = vi.fn()
      const rpc = vi.fn().mockResolvedValue({
        data: [{ user_id: 'user-123', company_id: 'company-456', api_key_name: OAUTH_MCP_KEY_NAME, rate_limited: false, client: 'claude' }],
        error: null,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockCreateClient.mockReturnValue({ rpc, from } as any)

      expect(await validateApiKey('gnubok_sk_test-key-value')).toMatchObject({ client: 'claude', clientName: null })
      expect(from).not.toHaveBeenCalled()
    })

    it('names an OAuth key mcp_oauth with its client, whichever door reads it', () => {
      expect(credentialActor({ apiKeyName: OAUTH_MCP_KEY_NAME, client: 'claude', serviceAccount: null })).toEqual({
        type: 'mcp_oauth',
        label: 'Claude (Anthropic)',
      })
      expect(credentialActor({ apiKeyName: OAUTH_MCP_KEY_NAME, client: 'chatgpt', serviceAccount: null }).label).toBe('ChatGPT (OpenAI)')
      expect(credentialActor({ apiKeyName: OAUTH_MCP_KEY_NAME, client: 'squidler', serviceAccount: null }).label).toBe('Squidler')
    })

    it('names a registered client by its own name', () => {
      expect(
        credentialActor({
          apiKeyName: OAUTH_MCP_KEY_NAME,
          client: 'registered:11111111-1111-4111-8111-111111111111',
          clientName: 'Egen klient (registered client)',
          serviceAccount: null,
        }),
      ).toEqual({ type: 'mcp_oauth', label: 'Egen klient (registered client)' })
    })

    it('keeps the reserved name on a connector whose client is not known', () => {
      expect(credentialActor({ apiKeyName: OAUTH_MCP_KEY_NAME, client: null, serviceAccount: null })).toEqual({
        type: 'mcp_oauth',
        label: OAUTH_MCP_KEY_NAME,
      })
      expect(credentialActor({ apiKeyName: OAUTH_MCP_KEY_NAME, client: 'something-new', serviceAccount: null }).label).toBe(OAUTH_MCP_KEY_NAME)
    })

    it('never names a service account an OAuth key, whatever the key is called', () => {
      expect(
        credentialActor({ apiKeyName: OAUTH_MCP_KEY_NAME, serviceAccount: { id: 'sa-1', name: 'Synk' } }),
      ).toEqual({ type: 'service_account', label: 'Synk' })
    })

    it('carries the key\'s unattended ceiling, so every door the request reaches is bound by it (#125)', () => {
      expect(credentialActor({ apiKeyName: 'Nyckel 1', serviceAccount: null, unattendedCommitLimit: 5000 })).toEqual({
        type: 'api_key',
        label: 'Nyckel 1',
        unattendedCommitLimit: 5000,
      })
      expect(
        credentialActor({ serviceAccount: { id: 'sa-1', name: 'Synk' }, unattendedCommitLimit: 5000 }),
      ).toMatchObject({ type: 'service_account', unattendedCommitLimit: 5000 })
      expect(credentialActor({ apiKeyName: 'Nyckel 1', serviceAccount: null, unattendedCommitLimit: null })).toEqual({
        type: 'api_key',
        label: 'Nyckel 1',
      })
    })
  })

  describe('unattended commit limit', () => {
    it('surfaces a positive ceiling from the RPC row', async () => {
      setupMockRpc({
        data: [{
          user_id: 'user-123',
          company_id: 'company-456',
          scopes: ['transactions:read'],
          rate_limited: false,
          // numeric(14,2) comes back from PostgREST as a string.
          unattended_commit_limit: '25000.00',
        }],
        error: null,
      })

      const result = await validateApiKey('gnubok_sk_test-key-value')
      expect(result).toMatchObject({ unattendedCommitLimit: 25000 })
    })

    it('reads anything that is not a positive number as no ceiling', async () => {
      // The whole guard is NULL-first: an unparseable or non-positive value
      // must mean "unlimited", never "block every commit this key attempts".
      for (const raw of [null, undefined, 0, -1, 'abc', {}]) {
        setupMockRpc({
          data: [{
            user_id: 'user-123',
            company_id: 'company-456',
            scopes: ['transactions:read'],
            rate_limited: false,
            unattended_commit_limit: raw,
          }],
          error: null,
        })
        const result = await validateApiKey('gnubok_sk_test-key-value')
        expect(result).toMatchObject({ unattendedCommitLimit: null })
      }
    })
  })

  describe('allowed company ids (per-key allowlist, migration 20260928112721)', () => {
    it('surfaces the allowlist from the RPC row', async () => {
      setupMockRpc({
        data: [{
          user_id: 'user-123',
          company_id: 'company-456',
          scopes: ['transactions:read'],
          rate_limited: false,
          allowed_company_ids: ['company-456', 'company-789'],
        }],
        error: null,
      })

      const result = await validateApiKey('gnubok_sk_test-key-value')
      expect(result).toMatchObject({ allowedCompanyIds: ['company-456', 'company-789'] })
    })

    it('reads an absent or null value as no allowlist', async () => {
      // Absent = a DB that has not run the migration: the key keeps reaching
      // every membership, exactly as before the column existed.
      for (const raw of [undefined, null]) {
        setupMockRpc({
          data: [{
            user_id: 'user-123',
            company_id: 'company-456',
            scopes: ['transactions:read'],
            rate_limited: false,
            allowed_company_ids: raw,
          }],
          error: null,
        })
        const result = await validateApiKey('gnubok_sk_test-key-value')
        expect(result).toMatchObject({ allowedCompanyIds: null })
      }
    })

    it('refuses the key when the allowlist is present but empty or malformed', async () => {
      // Fail closed: reading these as null would turn a restricted key into
      // one that reaches every company the user belongs to.
      for (const raw of [[], 'company-456', { 0: 'x' }, [42], ['']]) {
        setupMockRpc({
          data: [{
            user_id: 'user-123',
            company_id: 'company-456',
            scopes: ['transactions:read'],
            rate_limited: false,
            allowed_company_ids: raw,
          }],
          error: null,
        })
        const result = await validateApiKey('gnubok_sk_test-key-value')
        expect(result).toEqual({ error: 'Invalid API key', status: 401 })
      }
    })
  })

  describe('read-only company ids (per-company access level, migration 20260928112724)', () => {
    function rpcRow(allowed: unknown, readOnly: unknown) {
      return {
        data: [{
          user_id: 'user-123',
          company_id: 'company-456',
          scopes: ['transactions:read', 'invoices:write'],
          rate_limited: false,
          allowed_company_ids: allowed,
          read_only_company_ids: readOnly,
        }],
        error: null,
      }
    }

    it('surfaces the read-only companies from the RPC row', async () => {
      setupMockRpc(rpcRow(['company-456', 'company-789'], ['company-789']))

      const result = await validateApiKey('gnubok_sk_test-key-value')
      expect(result).toMatchObject({
        allowedCompanyIds: ['company-456', 'company-789'],
        readOnlyCompanyIds: ['company-789'],
      })
    })

    it('reads an absent or null value as no read-only company', async () => {
      // Absent = a DB without the column, where no read-only row can exist.
      for (const raw of [undefined, null]) {
        setupMockRpc(rpcRow(['company-456'], raw))
        const result = await validateApiKey('gnubok_sk_test-key-value')
        expect(result).toMatchObject({ readOnlyCompanyIds: null })
      }
    })

    it('refuses the key when the read-only list is present but unreadable or outside the allowlist', async () => {
      // Fail closed: reading any of these as "none" would let the key write
      // in a company the user chose read-only for.
      const cases: Array<[unknown, unknown]> = [
        [['company-456'], []],
        [['company-456'], 'company-456'],
        [['company-456'], [42]],
        [['company-456'], ['company-789']],
        [null, ['company-456']],
      ]
      for (const [allowed, readOnly] of cases) {
        setupMockRpc(rpcRow(allowed, readOnly))
        const result = await validateApiKey('gnubok_sk_test-key-value')
        expect(result).toEqual({ error: 'Invalid API key', status: 401 })
      }
    })
  })

  describe('unbound keys (minted before the first company existed, issue #1814)', () => {
    function setupUnboundKeyClient(rpcRow: Record<string, unknown>) {
      const chain = {
        update: vi.fn(),
        eq: vi.fn(),
        is: vi.fn().mockResolvedValue({ data: null, error: null }),
      }
      chain.update.mockReturnValue(chain)
      chain.eq.mockReturnValue(chain)
      const from = vi.fn().mockReturnValue(chain)
      const rpc = vi.fn().mockResolvedValue({ data: [rpcRow], error: null })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockCreateClient.mockReturnValue({ rpc, from } as any)
      return { from, chain }
    }

    const unboundRow = {
      user_id: 'user-123',
      company_id: null,
      api_key_id: 'ak_1',
      api_key_name: 'MCP-klient (OAuth)',
      scopes: ['transactions:read'],
      rate_limited: false,
      mode: 'live',
    }

    it('binds the key to the user\'s company once one exists and heals the row', async () => {
      const { from, chain } = setupUnboundKeyClient(unboundRow)
      contextMocks.getActiveCompanyId.mockResolvedValue('company-789')

      const result = await validateApiKey('gnubok_sk_test-key-value')

      expect('companyId' in result && result.companyId).toBe('company-789')
      expect(from).toHaveBeenCalledWith('api_keys')
      expect(chain.update).toHaveBeenCalledWith({ company_id: 'company-789' })
      expect(chain.eq).toHaveBeenCalledWith('id', 'ak_1')
      // Only an unbound row is ever rewritten: a concurrent bind must not be clobbered.
      expect(chain.is).toHaveBeenCalledWith('company_id', null)
    })

    it('returns companyId null while the user still has no company', async () => {
      const { from } = setupUnboundKeyClient(unboundRow)
      contextMocks.getActiveCompanyId.mockResolvedValue(null)

      const result = await validateApiKey('gnubok_sk_test-key-value')

      expect('companyId' in result && result.companyId).toBeNull()
      expect(from).not.toHaveBeenCalled()
    })

    it('treats a failed company resolution as still unbound rather than failing the key', async () => {
      setupUnboundKeyClient(unboundRow)
      contextMocks.getActiveCompanyId.mockRejectedValue(new Error('db blip'))

      const result = await validateApiKey('gnubok_sk_test-key-value')

      expect('companyId' in result && result.companyId).toBeNull()
      expect('userId' in result && result.userId).toBe('user-123')
    })

    it('skips the heal when the RPC predates api_key_id in its return shape', async () => {
      const { from } = setupUnboundKeyClient({ ...unboundRow, api_key_id: undefined })
      contextMocks.getActiveCompanyId.mockResolvedValue('company-789')

      const result = await validateApiKey('gnubok_sk_test-key-value')

      expect('companyId' in result && result.companyId).toBe('company-789')
      expect(from).not.toHaveBeenCalled()
    })
  })
})
