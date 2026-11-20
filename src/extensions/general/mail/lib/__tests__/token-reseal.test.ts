/**
 * Stored grants move to MAIL_TOKEN_ENCRYPTION_KEY as they are used: the
 * first refresh that reads a legacy refresh token writes it back sealed with
 * the dedicated key, once, and only over the ciphertext it read.
 */
import crypto from 'crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }))
vi.mock('../google-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../google-oauth')>()),
  getGoogleOAuthEnv: () => ({ clientId: 'c', clientSecret: 's', redirectUri: 'r' }),
  refreshAccessToken: (...args: unknown[]) => mockRefresh(...args),
}))

import { getAccessToken, type MailConnectionRow } from '../connections'
import { decryptToken, encryptToken } from '../crypto'

const SERVICE_ROLE = 'service-role-secret'

function legacySeal(plaintext: string): string {
  const key = crypto.createHash('sha256').update('mail-connections:v1:' + SERVICE_ROLE).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
}

function mockSupabase() {
  const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = []
  const client = {
    from() {
      const filters: Array<[string, unknown]> = []
      const chain: Record<string, unknown> = {
        update: (values: Record<string, unknown>) => {
          updates.push({ values, filters })
          return chain
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value])
          return chain
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      }
      return chain
    },
  }
  return { client: client as never, updates }
}

function connection(encryptedRefreshToken: string): MailConnectionRow {
  return {
    id: 'conn-1',
    company_id: 'co-1',
    provider: 'gmail',
    email_address: 'ekonomi@example.se',
    encrypted_refresh_token: encryptedRefreshToken,
    encrypted_access_token: null,
    access_token_expires_at: null,
    scope_label: null,
    status: 'active',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE)
  vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', 'ef'.repeat(32))
  mockRefresh.mockResolvedValue({ accessToken: 'access-new', expiresAt: new Date('2030-01-01T00:00:00Z') })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getAccessToken: re-sealing legacy refresh tokens', () => {
  it('writes a legacy refresh token back under the dedicated key, over the ciphertext it read', async () => {
    const legacy = legacySeal('refresh-prod')
    const { client, updates } = mockSupabase()

    await expect(getAccessToken(client, connection(legacy), 'https://app.example')).resolves.toBe('access-new')

    expect(mockRefresh).toHaveBeenCalledWith(expect.anything(), 'refresh-prod')
    const reseal = updates.find((u) => 'encrypted_refresh_token' in u.values)
    expect(reseal).toBeDefined()
    const sealed = reseal!.values.encrypted_refresh_token as string
    expect(sealed.startsWith('v2.')).toBe(true)
    expect(decryptToken(sealed)).toBe('refresh-prod')
    expect(reseal!.filters).toEqual([
      ['id', 'conn-1'],
      ['encrypted_refresh_token', legacy],
    ])
  })

  it('re-seals only once: a v2 refresh token is left as it is', async () => {
    const { client, updates } = mockSupabase()

    await getAccessToken(client, connection(encryptToken('refresh-v2')), 'https://app.example')

    expect(updates.some((u) => 'encrypted_refresh_token' in u.values)).toBe(false)
  })

  it('leaves legacy tokens alone when there is no dedicated key to seal with', async () => {
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', '')
    const { client, updates } = mockSupabase()

    await expect(getAccessToken(client, connection(legacySeal('refresh-prod')), 'https://app.example')).resolves.toBe(
      'access-new',
    )
    expect(updates.some((u) => 'encrypted_refresh_token' in u.values)).toBe(false)
  })

  it('does not re-seal a grant Google no longer accepts', async () => {
    mockRefresh.mockRejectedValue(new Error('network'))
    const { client, updates } = mockSupabase()

    await expect(getAccessToken(client, connection(legacySeal('refresh-prod')), 'https://app.example')).resolves.toBeNull()
    expect(updates.some((u) => 'encrypted_refresh_token' in u.values)).toBe(false)
  })

  it('fails closed on a v2 grant once the dedicated key is gone, without parking it', async () => {
    const sealed = encryptToken('refresh-v2')
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', '')
    const { client, updates } = mockSupabase()

    await expect(getAccessToken(client, connection(sealed), 'https://app.example')).resolves.toBeNull()
    expect(mockRefresh).not.toHaveBeenCalled()
    // A missing key is a configuration error: restoring it must bring the
    // mailbox back, so nothing is written.
    expect(updates).toEqual([])
  })
})
