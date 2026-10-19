import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  openConsentToken,
  readConsentTokens,
  resealConsentTokens,
  saveConsentTokens,
  sealConsentToken,
  sealLegacyConsentTokens,
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

// The rows written before the seal that no read or refresh touches again: the
// provider OAuth cleanup cron seals them a batch at a time.
describe('sealLegacyConsentTokens', () => {
  beforeEach(() => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'test-personnummer-key')
  })
  afterEach(() => vi.unstubAllEnvs())

  const legacy = (id: string, extra: Record<string, unknown> = {}) => ({
    consent_id: id, access_token: JWT, refresh_token: UUID, credential_revision: `${id}-r1`, ...extra,
  })

  it('seals every legacy row either read finds, once, guarded on its revision', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [legacy('c1'), legacy('c2', { refresh_token: null })] }) // plaintext access tokens
    mock.enqueue({ data: [legacy('c1'), legacy('c3', { access_token: sealConsentToken(BOKIO) })] }) // plaintext refresh tokens
    mock.enqueue({ data: [{ consent_id: 'c1', credential_revision: 'c1-r2' }] })
    mock.enqueue({ data: [{ consent_id: 'c2', credential_revision: 'c2-r2' }] })
    mock.enqueue({ data: [{ consent_id: 'c3', credential_revision: 'c3-r2' }] })

    await expect(sealLegacyConsentTokens(mock.supabase as never)).resolves.toEqual({ found: 3, sealed: 3 })

    expect(mock.findCalls('provider_consent_tokens', 'not')).toEqual([
      ['access_token', 'like', 'pct1:%'],
      ['refresh_token', 'like', 'pct1:%'],
    ])
    const updates = mock.findCalls('provider_consent_tokens', 'update').map(([patch]) => patch as Record<string, string>)
    expect(updates).toHaveLength(3)
    for (const patch of updates) {
      expect(JSON.stringify(patch)).not.toContain(JWT)
      expect(JSON.stringify(patch)).not.toContain(UUID)
    }
    expect(updates.map(p => openConsentToken(p.access_token!))).toEqual([JWT, JWT, BOKIO])
    expect(updates.map(p => p.refresh_token && openConsentToken(p.refresh_token))).toEqual([UUID, undefined, UUID])
    expect(mock.findCalls('provider_consent_tokens', 'eq').filter(([column]) => column === 'credential_revision'))
      .toEqual([['credential_revision', 'c1-r1'], ['credential_revision', 'c2-r1'], ['credential_revision', 'c3-r1']])
  })

  it('reads twice and writes nothing once every row is sealed', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    await expect(sealLegacyConsentTokens(mock.supabase as never)).resolves.toEqual({ found: 0, sealed: 0 })
    expect(mock.findCall('provider_consent_tokens', 'update')).toBeUndefined()
  })

  it('leaves a row a concurrent refresh rotated for the next run', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [legacy('c1'), legacy('c2')] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] }) // c1: the revision moved, no row matched
    mock.enqueue({ data: [{ consent_id: 'c2', credential_revision: 'c2-r2' }] })
    await expect(sealLegacyConsentTokens(mock.supabase as never)).resolves.toEqual({ found: 2, sealed: 1 })
  })

  it('takes at most one batch per run', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [legacy('c1'), legacy('c2')] })
    mock.enqueue({ data: [legacy('c3')] })
    mock.enqueue({ data: [{ consent_id: 'c1', credential_revision: 'c1-r2' }] })
    mock.enqueue({ data: [{ consent_id: 'c2', credential_revision: 'c2-r2' }] })
    await expect(sealLegacyConsentTokens(mock.supabase as never, 2)).resolves.toEqual({ found: 2, sealed: 2 })
    expect(mock.findCalls('provider_consent_tokens', 'limit')).toEqual([[2], [2]])
    expect(mock.findCalls('provider_consent_tokens', 'update')).toHaveLength(2)
  })

  it('writes nothing without the key and says how many rows wait', async () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', '')
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [legacy('c1')] })
    mock.enqueue({ data: [] })
    await expect(sealLegacyConsentTokens(mock.supabase as never)).resolves.toEqual({ found: 1, sealed: 0 })
    expect(mock.findCall('provider_consent_tokens', 'update')).toBeUndefined()
  })

  it('skips a row it cannot open and seals the rest', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [legacy('c1', { access_token: 'pct1:not-a-sealed-value' }), legacy('c2')] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ consent_id: 'c2', credential_revision: 'c2-r2' }] })
    await expect(sealLegacyConsentTokens(mock.supabase as never)).resolves.toEqual({ found: 2, sealed: 1 })
  })

  it('fails the run on a read error without naming a token', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ error: { message: 'connection reset' } })
    mock.enqueue({ data: [legacy('c1')] })
    const err: unknown = await sealLegacyConsentTokens(mock.supabase as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('connection reset')
    expect((err as Error).message).not.toContain(JWT)
    expect(mock.findCall('provider_consent_tokens', 'update')).toBeUndefined()
  })
})
