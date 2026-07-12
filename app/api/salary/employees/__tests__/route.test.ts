/**
 * Regression test for the plaintext-personnummer crash, plus auth wiring.
 *
 * GET /api/salary/employees decrypts every employee's personnummer on read and
 * maps over the whole roster. A row whose personnummer was stored UNENCRYPTED
 * (a pre-fix v1 REST create, or a seed) used to throw
 * ERR_CRYPTO_INVALID_AUTH_TAG ("Invalid authentication tag length: 6") inside
 * the .map(), 500-ing the entire endpoint for the affected company. The decrypt
 * helper now passes a raw 12-digit value through unchanged, so a mixed
 * encrypted/plaintext table no longer takes the roster down.
 *
 * The route now runs through the withRouteContext wrapper, so we mock its
 * auth/company/write dependencies and inject the Supabase client via requireAuth.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getCompanyEntityType: vi.fn(),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

// Synthetic 12-digit values (year 1900 / 1902, zero suffix): obviously not
// real birthdates. ISO A.5.34 / GDPR Art.5(1)(c): fixtures must not look like
// production PII.
const PLAINTEXT_PNR = '190001010000'
const ENCRYPTED_PNR = encryptPersonnummer('190203040000')

function supabaseWithRows(rows: unknown[]) {
  const query: Record<string, unknown> = {}
  query.select = vi.fn(() => query)
  query.eq = vi.fn(() => query)
  query.order = vi.fn(() => Promise.resolve({ data: rows, error: null }))
  return { from: vi.fn(() => query) }
}

function authed(supabase: unknown) {
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: 'user-1' } as never,
    supabase: supabase as never,
    error: null,
  } as never)
}

function req() {
  return new Request('https://x.test/api/salary/employees')
}

const params = { params: Promise.resolve({}) } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/salary/employees', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)

    const res = await GET(req(), params)
    expect(res.status).toBe(401)
  })

  it('does not 500 on a mixed plaintext + encrypted roster; masks both', async () => {
    authed(
      supabaseWithRows([
        { id: 'e1', last_name: 'A', personnummer: PLAINTEXT_PNR },
        { id: 'e2', last_name: 'B', personnummer: ENCRYPTED_PNR },
      ]),
    )

    const res = await GET(req(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Both rows masked birthdate-visible, last-4 hidden.
    expect(body.data[0].personnummer).toBe('19000101-XXXX')
    expect(body.data[1].personnummer).toBe('19020304-XXXX')
    // Neither the plaintext nor the stored ciphertext may leak.
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_PNR)
    expect(JSON.stringify(body)).not.toContain(ENCRYPTED_PNR)
  })
})
