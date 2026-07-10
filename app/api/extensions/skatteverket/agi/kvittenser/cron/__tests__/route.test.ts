/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn().mockReturnValue(null),
}))

vi.mock('@/extensions/general/skatteverket/lib/agi-client', () => ({
  agiGetKvittenser: vi.fn(),
}))

// Provide the class in the mock factory so both the route's instanceof
// checks and the errors constructed in tests use the same identity,
// without loading the real api-client module (oauth, rate limiter, ...).
vi.mock('@/extensions/general/skatteverket/lib/api-client', () => {
  class SkatteverketAuthError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message)
      this.name = 'SkatteverketAuthError'
    }
  }
  return { SkatteverketAuthError }
})

vi.mock('@/extensions/general/skatteverket/lib/token-store', () => ({
  // Mirrors the real RECONSENT_ERROR_CODES: terminal codes that only a
  // fresh BankID consent can fix.
  RECONSENT_ERROR_CODES: [
    'SESSION_EXPIRED',
    'REFRESH_EXHAUSTED',
    'MISSING_SCOPE',
    'TOKEN_CORRUPTED',
  ] as const,
  markNeedsReconsent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: vi.fn().mockResolvedValue(true),
}))

import { GET } from '../route'
import { createClient } from '@supabase/supabase-js'
import { verifyCronSecret } from '@/lib/auth/cron'
import { agiGetKvittenser } from '@/extensions/general/skatteverket/lib/agi-client'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { markNeedsReconsent } from '@/extensions/general/skatteverket/lib/token-store'

const mockCreateClient = vi.mocked(createClient)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockAgiGetKvittenser = vi.mocked(agiGetKvittenser)
const mockMarkNeedsReconsent = vi.mocked(markNeedsReconsent)

function makeRequest() {
  return new Request('http://localhost/api/extensions/skatteverket/agi/kvittenser/cron', {
    headers: { authorization: 'Bearer test-secret' },
  })
}

const PENDING_DECLARATION = {
  id: 'decl-1',
  company_id: 'comp-1',
  salary_run_id: null,
  period_year: 2026,
  period_month: 5,
}

/**
 * Generic chainable Supabase stub: from(table) returns a chain whose
 * terminal calls (maybeSingle/single/await) resolve to the per-table
 * result. Good enough for this route: it never branches on update or
 * delete results.
 */
function makeSupabaseStub(tables: Record<string, { data: unknown; error?: unknown }>) {
  return {
    from: vi.fn((table: string) => {
      const result = tables[table] ?? { data: null, error: null }
      const resolved = { data: result.data, error: result.error ?? null }
      const chain: any = {}
      for (const method of ['select', 'eq', 'order', 'limit', 'update', 'delete']) {
        chain[method] = vi.fn(() => chain)
      }
      chain.maybeSingle = vi.fn().mockResolvedValue(resolved)
      chain.single = vi.fn().mockResolvedValue(resolved)
      chain.then = (resolve: (v: unknown) => void) => resolve(resolved)
      return chain
    }),
  } as any
}

function stubHappyTables() {
  return makeSupabaseStub({
    agi_declarations: { data: [PENDING_DECLARATION] },
    skatteverket_tokens: { data: { user_id: 'user-1', status: 'active' } },
    company_settings: { data: { org_number: '556123-4567', entity_type: 'aktiebolag' } },
  })
}

describe('AGI kvittenser cron', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SKATTEVERKET_ENABLED = 'true'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    mockVerifyCronSecret.mockReturnValue(null)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    logSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('returns 401 when cron auth fails', async () => {
    mockVerifyCronSecret.mockReturnValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) as any,
    )

    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('marks the declaration signed when a kvittens exists', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        kvittenser: [
          {
            uuidKvittens: 'uuid-1',
            signeradAv: '191212121212',
            signeradTid: '2026-06-01T10:00:00Z',
          },
        ],
      },
    } as any)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.signed).toBe(1)
    expect(body.errors).toBe(0)
    expect(body.results[0].status).toBe('signed')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logs a warn (not error) and records apigw_config on ACCESS_DENIED', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Skatteverkets API-gateway nekade anropet.', 'ACCESS_DENIED'),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(1)
    expect(body.apigwConfig).toBe(1)
    expect(body.errors).toBe(0)
    expect(body.results[0]).toMatchObject({
      declarationId: 'decl-1',
      companyId: 'comp-1',
      status: 'apigw_config',
      error: 'ACCESS_DENIED',
    })

    // Warn carries the actionable config hint plus the context to act on it.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [warnMessage, warnContext] = warnSpy.mock.calls[0]
    expect(warnMessage).toContain('Utvecklarportalen')
    expect(warnMessage).toContain('SKATTEVERKET_APIGW_CLIENT_ID')
    expect(warnContext).toMatchObject({
      declarationId: 'decl-1',
      companyId: 'comp-1',
      period: expect.any(String),
    })

    // The whole point: no error-level log for a config gap retries cannot heal.
    expect(errorSpy).not.toHaveBeenCalled()
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()

    // The config gap stays visible in the run summary.
    const summaryLine = logSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('Processed'))
    expect(summaryLine).toContain('1 apigw config gaps')
  })

  it('warns once per run on ACCESS_DENIED but records apigw_config for every declaration', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub({
        agi_declarations: {
          data: [
            PENDING_DECLARATION,
            { ...PENDING_DECLARATION, id: 'decl-2', company_id: 'comp-2' },
            { ...PENDING_DECLARATION, id: 'decl-3', company_id: 'comp-3' },
          ],
        },
        skatteverket_tokens: { data: { user_id: 'user-1', status: 'active' } },
        company_settings: { data: { org_number: '556123-4567', entity_type: 'aktiebolag' } },
      }),
    )
    for (let i = 0; i < 3; i++) {
      mockAgiGetKvittenser.mockRejectedValueOnce(
        new SkatteverketAuthError('Skatteverkets API-gateway nekade anropet.', 'ACCESS_DENIED'),
      )
    }

    const res = await GET(makeRequest())
    const body = await res.json()

    // Every affected declaration still gets its apigw_config outcome.
    expect(body.processed).toBe(3)
    expect(body.apigwConfig).toBe(3)
    expect(body.errors).toBe(0)
    expect(body.results.map((r: { declarationId: string }) => r.declarationId)).toEqual([
      'decl-1',
      'decl-2',
      'decl-3',
    ])
    expect(body.results.every((r: { status: string }) => r.status === 'apigw_config')).toBe(true)

    // But the identical config-gap warning is logged exactly once per run.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('Utvecklarportalen')
    expect(errorSpy).not.toHaveBeenCalled()

    const summaryLine = logSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('Processed'))
    expect(summaryLine).toContain('3 apigw config gaps')
  })

  it('still flags reconsent codes as expired_token and marks the connection', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Sessionen har gått ut.', 'SESSION_EXPIRED'),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.expired).toBe(1)
    expect(body.apigwConfig).toBe(0)
    expect(body.results[0]).toMatchObject({ status: 'expired_token', error: 'SESSION_EXPIRED' })
    expect(mockMarkNeedsReconsent).toHaveBeenCalledWith(expect.anything(), 'user-1', 'SESSION_EXPIRED')
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('still records expired_token for TOKEN_REVOKED without reconsent flagging', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Token has been revoked.', 'TOKEN_REVOKED'),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.expired).toBe(1)
    expect(body.results[0]).toMatchObject({ status: 'expired_token', error: 'TOKEN_REVOKED' })
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('still logs at error level for other SkatteverketAuthError codes', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Du har inte behörighet.', 'BEHORIGHET_SAKNAS'),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    expect(body.apigwConfig).toBe(0)
    expect(body.results[0]).toMatchObject({ status: 'error', error: 'Du har inte behörighet.' })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('Reconciliation failed')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('still logs at error level for generic errors', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(new Error('fetch failed'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    expect(body.results[0]).toMatchObject({ status: 'error', error: 'fetch failed' })
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})
