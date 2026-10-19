import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  openConsentToken,
  readConsentTokens,
  resealConsentTokens,
  saveConsentTokens,
  sealConsentToken,
  updateConsentTokens,
} from '../consent-tokens'

// Shapes of the stored values today: a Fortnox/Visma JWT, a Briox/BL uuid, a
// Bokio API token. None contains a colon, which is what the prefix relies on.
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl'
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const BOKIO = 'Ym9raW8tYXBpLXRva2VuLWV4YW1wbGU='

describe('consent token sealing', () => {
  beforeEach(() => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'test-personnummer-key')
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each([JWT, UUID, BOKIO])('seals a token so the stored value does not contain it, and opens it again', (token) => {
    const sealed = sealConsentToken(token)
    expect(sealed.startsWith('pct1:')).toBe(true)
    expect(sealed).not.toContain(token)
    expect(sealConsentToken(token)).not.toBe(sealed) // fresh IV per seal
    expect(openConsentToken(sealed)).toBe(token)
  })

  it.each([JWT, UUID, BOKIO])('opens a legacy plaintext token as is, even without the key', (token) => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', '')
    expect(openConsentToken(token)).toBe(token)
  })

  it('refuses to seal without the key instead of storing the token raw', () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', '')
    expect(() => sealConsentToken(JWT)).toThrow('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
  })

  it('does not open a value sealed under another key', () => {
    const sealed = sealConsentToken(JWT)
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'another-key')
    expect(() => openConsentToken(sealed)).toThrow()
  })

  it('saves both tokens sealed and every other column as given', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null })
    await saveConsentTokens(mock.supabase as never, {
      consent_id: 'c1', provider: 'fortnox', access_token: JWT, refresh_token: UUID,
      token_expires_at: '2026-10-19T12:00:00.000Z', provider_company_id: 'acct-1',
    })
    const row = mock.findCall('provider_consent_tokens', 'upsert')?.[0] as Record<string, string>
    expect(row).toMatchObject({ consent_id: 'c1', provider: 'fortnox', token_expires_at: '2026-10-19T12:00:00.000Z', provider_company_id: 'acct-1' })
    expect(JSON.stringify(row)).not.toContain(JWT)
    expect(JSON.stringify(row)).not.toContain(UUID)
    expect(openConsentToken(row.access_token!)).toBe(JWT)
    expect(openConsentToken(row.refresh_token!)).toBe(UUID)
  })

  it('keeps a missing refresh token null when saving', async () => {
    const mock = createQueuedMockSupabase()
    await saveConsentTokens(mock.supabase as never, { consent_id: 'c1', provider: 'bokio', access_token: BOKIO, refresh_token: null })
    const row = mock.findCall('provider_consent_tokens', 'upsert')?.[0] as Record<string, unknown>
    expect(row.refresh_token).toBeNull()
    expect(openConsentToken(row.access_token as string)).toBe(BOKIO)
  })

  it('seals the tokens of an update and leaves the rest of the patch alone', async () => {
    const mock = createQueuedMockSupabase()
    await updateConsentTokens(mock.supabase as never, 'c1', { access_token: JWT, token_expires_at: '2026-10-19T12:00:00.000Z' })
    const patch = mock.findCall('provider_consent_tokens', 'update')?.[0] as Record<string, unknown>
    expect(Object.keys(patch).sort()).toEqual(['access_token', 'token_expires_at'])
    expect(openConsentToken(patch.access_token as string)).toBe(JWT)
    expect(mock.findCall('provider_consent_tokens', 'eq')).toEqual(['consent_id', 'c1'])
  })

  it('reads a sealed row opened and not as plaintext', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [{ consent_id: 'c1', access_token: sealConsentToken(JWT), refresh_token: sealConsentToken(UUID), credential_revision: 'r1' }] })
    const { tokens, plaintext } = await readConsentTokens(mock.supabase as never, 'c1')
    expect(tokens).toMatchObject({ access_token: JWT, refresh_token: UUID, credential_revision: 'r1' })
    expect(plaintext).toBe(false)
  })

  it.each([
    ['both tokens', { access_token: JWT, refresh_token: UUID }],
    ['the refresh token', { access_token: 'sealed', refresh_token: UUID }],
    ['a token without refresh token', { access_token: BOKIO, refresh_token: null }],
  ])('reads a legacy row holding %s in plaintext and says so', async (_label, stored) => {
    const row = { ...stored, access_token: stored.access_token === 'sealed' ? sealConsentToken(JWT) : stored.access_token }
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [row] })
    const { tokens, plaintext } = await readConsentTokens(mock.supabase as never, 'c1')
    expect(plaintext).toBe(true)
    expect(tokens?.refresh_token).toBe(stored.refresh_token)
  })

  it('reads no row on a read error', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ error: { message: 'connection reset' } })
    const result = await readConsentTokens(mock.supabase as never, 'c1')
    expect(result.tokens).toBeUndefined()
    expect(result.error).toEqual({ message: 'connection reset' })
  })

  it('reseals a legacy row guarded on its revision and hands out the new revision', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [{ consent_id: 'c1', credential_revision: 'r2' }] })
    const revision = await resealConsentTokens(mock.supabase as never, 'c1', { access_token: JWT, refresh_token: UUID, credential_revision: 'r1' })
    expect(revision).toBe('r2')
    const patch = mock.findCall('provider_consent_tokens', 'update')?.[0] as Record<string, string>
    expect(Object.keys(patch).sort()).toEqual(['access_token', 'refresh_token'])
    expect(openConsentToken(patch.access_token!)).toBe(JWT)
    expect(openConsentToken(patch.refresh_token!)).toBe(UUID)
    expect(mock.findCalls('provider_consent_tokens', 'eq')).toEqual([['consent_id', 'c1'], ['credential_revision', 'r1']])
  })

  it('keeps the old revision when a concurrent rotation won or the write failed', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [] })
    mock.enqueue({ error: { message: 'connection reset' } })
    const tokens = { access_token: BOKIO, refresh_token: null, credential_revision: 'r1' }
    await expect(resealConsentTokens(mock.supabase as never, 'c1', tokens)).resolves.toBe('r1')
    await expect(resealConsentTokens(mock.supabase as never, 'c1', tokens)).resolves.toBe('r1')
  })

  it('leaves the row readable as it was when the key is missing', async () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', '')
    const mock = createQueuedMockSupabase()
    await expect(resealConsentTokens(mock.supabase as never, 'c1', { access_token: JWT, credential_revision: 'r1' })).resolves.toBe('r1')
    expect(mock.findCall('provider_consent_tokens', 'update')).toBeUndefined()
  })

  it('does not reseal a row without a revision to guard on', async () => {
    const mock = createQueuedMockSupabase()
    await expect(resealConsentTokens(mock.supabase as never, 'c1', { access_token: JWT })).resolves.toBeUndefined()
    expect(mock.findCall('provider_consent_tokens', 'update')).toBeUndefined()
  })
})
