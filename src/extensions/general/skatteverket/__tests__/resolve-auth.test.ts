/**
 * resolveReadAuth preference matrix: system credentials when the flag is on
 * and the grant is verified; the company's user token otherwise; explicit
 * no_token / needs_reconsent outcomes for the crons' quiet buckets.
 *
 * Token rows are per (user, company): the caller's own row wins when it
 * exists, any other member's active row serves otherwise (#1673), and two
 * connected members must never degrade to "nobody connected".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetConnection = vi.fn()
vi.mock('../lib/connection-store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, getConnection: (...a: unknown[]) => mockGetConnection(...a) }
})

const mockMode = vi.fn()
const mockConfigured = vi.fn()
vi.mock('../lib/system-auth/config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getSystemAuthMode: () => mockMode(),
    isSystemAuthConfigured: () => mockConfigured(),
  }
})

import { resolveReadAuth, hasVerifiedGrant, findCompanyTokenUser } from '../lib/resolve-auth'
import type { SupabaseClient } from '@supabase/supabase-js'

type TokenRow = { user_id: string; status: string; created_at?: string }

/**
 * Chain stub for the company token lookup: `.select().eq().order()` resolves
 * to the given rows, already in created_at DESC order (the DB does the
 * ordering; the resolver only picks). Pass a single row for the one-member
 * case, an array for several members, null for no rows.
 */
function makeSupabase(
  tokenRows: TokenRow | TokenRow[] | null,
  opts: { error?: { message: string } } = {},
) {
  const rows = tokenRows === null ? [] : Array.isArray(tokenRows) ? tokenRows : [tokenRows]
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.order = vi.fn().mockResolvedValue(
    opts.error ? { data: null, error: opts.error } : { data: rows, error: null },
  )
  // Regression guard for #1673: the company lookup must never go through
  // maybeSingle(), which errors as soon as two members have connected.
  chain.maybeSingle = vi.fn(() => {
    throw new Error('maybeSingle() must not be used for the company token lookup')
  })
  return { from: vi.fn(() => chain), _chain: chain } as unknown as SupabaseClient & {
    _chain: Record<string, ReturnType<typeof vi.fn>>
  }
}

const GRANTED_CONNECTION = {
  status: 'verified',
  lasombud_status: 'granted',
  moms_ombud_status: 'granted',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockMode.mockReturnValue('off')
  mockConfigured.mockReturnValue(false)
})

describe('resolveReadAuth', () => {
  it('mode off -> user token by company lookup (pre-hybrid behavior)', async () => {
    const supabase = makeSupabase({ user_id: 'user-1', status: 'active' })
    const result = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })
    expect(result).toMatchObject({ ok: true, source: 'user', tokenUserId: 'user-1' })
    expect(mockGetConnection).not.toHaveBeenCalled()
  })

  it('mode on + verified grant -> system auth', async () => {
    mockMode.mockReturnValue('on')
    mockConfigured.mockReturnValue(true)
    mockGetConnection.mockResolvedValue(GRANTED_CONNECTION)

    const supabase = makeSupabase({ user_id: 'user-1', status: 'active' })
    const result = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })

    expect(result).toMatchObject({ ok: true, source: 'system', tokenUserId: 'user-1' })
    if (result.ok) expect(result.auth).toEqual({ mode: 'system' })
  })

  it('mode on but grant denied -> falls back to user token', async () => {
    mockMode.mockReturnValue('on')
    mockConfigured.mockReturnValue(true)
    mockGetConnection.mockResolvedValue({
      ...GRANTED_CONNECTION,
      lasombud_status: 'denied',
      status: 'partial',
    })

    const supabase = makeSupabase({ user_id: 'user-1', status: 'active' })
    const result = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })
    expect(result).toMatchObject({ ok: true, source: 'user' })
  })

  it('mode on but unconfigured -> never consults the connection table', async () => {
    mockMode.mockReturnValue('on')
    mockConfigured.mockReturnValue(false)

    const supabase = makeSupabase({ user_id: 'user-1', status: 'active' })
    const result = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })
    expect(result).toMatchObject({ ok: true, source: 'user' })
    expect(mockGetConnection).not.toHaveBeenCalled()
  })

  it('shadow mode never selects system auth', async () => {
    mockMode.mockReturnValue('shadow')
    mockConfigured.mockReturnValue(true)
    mockGetConnection.mockResolvedValue(GRANTED_CONNECTION)

    const supabase = makeSupabase({ user_id: 'user-1', status: 'active' })
    const result = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })
    expect(result).toMatchObject({ ok: true, source: 'user' })
  })

  it('explicit userId with no company row at all -> no_token (no longer short-circuits to the caller)', async () => {
    const supabase = makeSupabase(null)
    const result = await resolveReadAuth(supabase, 'company-1', {
      requires: 'moms_ombud',
      userId: 'user-9',
    })
    expect(result).toEqual({ ok: false, reason: 'no_token' })
  })

  it('orders the company lookup by created_at desc and filters by company', async () => {
    const supabase = makeSupabase({ user_id: 'user-1', status: 'active' })
    await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })
    expect(supabase._chain.eq).toHaveBeenCalledWith('company_id', 'company-1')
    expect(supabase._chain.order).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('lookup error -> no_token (never throws into the caller)', async () => {
    const supabase = makeSupabase(null, { error: { message: 'boom' } })
    const result = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })
    expect(result).toEqual({ ok: false, reason: 'no_token' })
  })

  it('no token row -> no_token', async () => {
    const supabase = makeSupabase(null)
    const result = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })
    expect(result).toEqual({ ok: false, reason: 'no_token' })
  })

  it('needs_reconsent row -> needs_reconsent', async () => {
    const supabase = makeSupabase({ user_id: 'user-1', status: 'needs_reconsent' })
    const result = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })
    expect(result).toEqual({ ok: false, reason: 'needs_reconsent' })
  })
})

describe('resolveReadAuth: two members of the same company (#1673)', () => {
  const A = 'user-a'
  const B = 'user-b'
  const NEWER = '2026-08-18T10:00:00Z'
  const OLDER = '2026-08-18T09:00:00Z'

  it('one connects, both read: the member who never connected resolves the connected token', async () => {
    const supabase = makeSupabase({ user_id: A, status: 'active', created_at: NEWER })

    const asA = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud', userId: A })
    expect(asA).toMatchObject({ ok: true, source: 'user', tokenUserId: A })

    const asB = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud', userId: B })
    expect(asB).toMatchObject({ ok: true, source: 'user', tokenUserId: A })
    // The auth handed to skvRequest carries the token OWNER: the refresh
    // writes back to A's row, never to B's (missing) one.
    if (asB.ok) expect(asB.auth).toEqual({ mode: 'user', supabase, userId: A, companyId: 'company-1' })
  })

  it('both connect, both read: each member gets their own token, nobody degrades to no_token', async () => {
    const supabase = makeSupabase([
      { user_id: B, status: 'active', created_at: NEWER },
      { user_id: A, status: 'active', created_at: OLDER },
    ])

    const asA = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud', userId: A })
    expect(asA).toMatchObject({ ok: true, tokenUserId: A })

    const asB = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud', userId: B })
    expect(asB).toMatchObject({ ok: true, tokenUserId: B })
  })

  it('both connect, background read (no caller): the most recently issued row wins', async () => {
    const supabase = makeSupabase([
      { user_id: B, status: 'active', created_at: NEWER },
      { user_id: A, status: 'active', created_at: OLDER },
    ])
    const result = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })
    expect(result).toMatchObject({ ok: true, tokenUserId: B })
  })

  it('a dead own row does not shadow another member\'s live token', async () => {
    const supabase = makeSupabase([
      { user_id: B, status: 'needs_reconsent', created_at: NEWER },
      { user_id: A, status: 'active', created_at: OLDER },
    ])
    const asB = await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud', userId: B })
    expect(asB).toMatchObject({ ok: true, tokenUserId: A })
  })

  it('every row flagged needs_reconsent -> needs_reconsent (own row reported when present)', async () => {
    const supabase = makeSupabase([
      { user_id: A, status: 'needs_reconsent', created_at: NEWER },
      { user_id: B, status: 'needs_reconsent', created_at: OLDER },
    ])
    expect(await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud', userId: B })).toEqual({
      ok: false,
      reason: 'needs_reconsent',
    })
    expect(await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })).toEqual({
      ok: false,
      reason: 'needs_reconsent',
    })
  })

  it('system mode keeps the caller as notification recipient, falls back to the token owner', async () => {
    mockMode.mockReturnValue('on')
    mockConfigured.mockReturnValue(true)
    mockGetConnection.mockResolvedValue(GRANTED_CONNECTION)
    const supabase = makeSupabase({ user_id: A, status: 'active', created_at: NEWER })

    expect(
      await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud', userId: B }),
    ).toMatchObject({ ok: true, source: 'system', tokenUserId: B })
    expect(await resolveReadAuth(supabase, 'company-1', { requires: 'lasombud' })).toMatchObject({
      ok: true,
      source: 'system',
      tokenUserId: A,
    })
  })
})

describe('findCompanyTokenUser', () => {
  it('returns null for a company with no rows', async () => {
    expect(await findCompanyTokenUser(makeSupabase(null), 'company-1')).toBeNull()
  })

  it('prefers the given user, then active status, then recency', async () => {
    const supabase = makeSupabase([
      { user_id: 'user-c', status: 'needs_reconsent', created_at: '3' },
      { user_id: 'user-b', status: 'active', created_at: '2' },
      { user_id: 'user-a', status: 'active', created_at: '1' },
    ])
    expect(await findCompanyTokenUser(supabase, 'company-1')).toEqual({
      userId: 'user-b',
      needsReconsent: false,
      createdAt: '2',
    })
    expect(await findCompanyTokenUser(supabase, 'company-1', { preferUserId: 'user-a' })).toEqual({
      userId: 'user-a',
      needsReconsent: false,
      createdAt: '1',
    })
    // Preferring a user whose row is dead still yields the live row.
    expect(await findCompanyTokenUser(supabase, 'company-1', { preferUserId: 'user-c' })).toEqual({
      userId: 'user-b',
      needsReconsent: false,
      createdAt: '2',
    })
  })
})

describe('hasVerifiedGrant', () => {
  it('requires both the grant and a verified/partial aggregate status', async () => {
    mockGetConnection.mockResolvedValue({
      status: 'revoked',
      lasombud_status: 'granted',
      moms_ombud_status: 'unknown',
    })
    expect(await hasVerifiedGrant('company-1', 'lasombud')).toBe(false)

    mockGetConnection.mockResolvedValue({
      status: 'partial',
      lasombud_status: 'granted',
      moms_ombud_status: 'denied',
    })
    expect(await hasVerifiedGrant('company-1', 'lasombud')).toBe(true)
    expect(await hasVerifiedGrant('company-1', 'moms_ombud')).toBe(false)
  })

  it('returns false when no connection row exists', async () => {
    mockGetConnection.mockResolvedValue(null)
    expect(await hasVerifiedGrant('company-1', 'lasombud')).toBe(false)
  })
})
