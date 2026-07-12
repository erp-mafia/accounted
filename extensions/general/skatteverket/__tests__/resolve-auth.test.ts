/**
 * resolveReadAuth preference matrix: system credentials when the flag is on
 * and the grant is verified; the company's user token otherwise; explicit
 * no_token / needs_reconsent outcomes for the crons' quiet buckets.
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

import { resolveReadAuth, hasVerifiedGrant } from '../lib/resolve-auth'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeSupabase(tokenRow: { user_id: string; status: string } | null) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: tokenRow, error: null })
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient
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

  it('explicit userId short-circuits the company lookup', async () => {
    const supabase = makeSupabase(null)
    const result = await resolveReadAuth(supabase, 'company-1', {
      requires: 'moms_ombud',
      userId: 'user-9',
    })
    expect(result).toMatchObject({ ok: true, source: 'user', tokenUserId: 'user-9' })
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
