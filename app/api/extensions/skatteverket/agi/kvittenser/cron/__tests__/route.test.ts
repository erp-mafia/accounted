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

// The route and the reconcile helper log through '@/lib/logger'. The real
// logger suppresses info/warn under NODE_ENV=test, so warn/error output is
// observed via these recorders instead of console spies. Console spies stay
// for the route's remaining console.* lines (summary, skip).
const { warnRecorder, errorRecorder } = vi.hoisted(() => ({
  warnRecorder: vi.fn(),
  errorRecorder: vi.fn(),
}))

vi.mock('@/lib/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: warnRecorder,
    error: errorRecorder,
    child: (): unknown => logger,
  }
  return { createLogger: () => logger }
})

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
  return {
    SkatteverketAuthError,
    // resolve-auth's currentSkvEnvironment (grant-revoked path) reads this.
    getSkatteverketEnvironment: vi.fn().mockReturnValue('test'),
  }
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

// The route's real connection-store hits the DB via its own service client;
// mocking keeps the grant-revoked path deterministic. resolve-auth also
// imports getConnection from here (only used when system auth mode is on,
// which is off in tests), so export it too.
vi.mock('@/extensions/general/skatteverket/lib/connection-store', () => ({
  getConnection: vi.fn().mockResolvedValue(null),
  markGrantRevoked: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/deadlines/complete-tax-deadline', () => ({
  completeTaxDeadline: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/extensions/general/skatteverket/lib/kvittens-notification', () => ({
  sendKvittensNotification: vi.fn().mockResolvedValue(undefined),
}))

import { GET } from '../route'
import { createClient } from '@supabase/supabase-js'
import { verifyCronSecret } from '@/lib/auth/cron'
import { agiGetKvittenser } from '@/extensions/general/skatteverket/lib/agi-client'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { markNeedsReconsent } from '@/extensions/general/skatteverket/lib/token-store'
import { markGrantRevoked } from '@/extensions/general/skatteverket/lib/connection-store'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import { sendKvittensNotification } from '@/extensions/general/skatteverket/lib/kvittens-notification'

const mockCreateClient = vi.mocked(createClient)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockAgiGetKvittenser = vi.mocked(agiGetKvittenser)
const mockMarkNeedsReconsent = vi.mocked(markNeedsReconsent)
const mockMarkGrantRevoked = vi.mocked(markGrantRevoked)
const mockCompleteTaxDeadline = vi.mocked(completeTaxDeadline)
const mockSendKvittensNotification = vi.mocked(sendKvittensNotification)

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
      for (const method of ['select', 'eq', 'in', 'order', 'limit', 'update', 'delete', 'insert']) {
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
    skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
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
    expect(body.grantRevoked).toBe(0)
    expect(body.results[0].status).toBe('signed')
    // Tenant identifiers stay in internal log context only.
    expect(body.results[0]).not.toHaveProperty('companyId')
    expect(mockCompleteTaxDeadline).toHaveBeenCalledTimes(1)
    expect(mockSendKvittensNotification).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(errorRecorder).not.toHaveBeenCalled()
  })

  it('still reports signed and sends the notification when completeTaxDeadline throws', async () => {
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
    mockCompleteTaxDeadline.mockRejectedValueOnce(new Error('deadline table unavailable'))

    const res = await GET(makeRequest())
    const body = await res.json()

    // The filing succeeded before the best-effort step failed: the row must
    // still land as signed, never as error (the next run only revisits
    // pending_signature rows, so an error here would be lost permanently).
    expect(body.signed).toBe(1)
    expect(body.errors).toBe(0)
    expect(body.results[0].status).toBe('signed')

    // The notification still goes out even though deadline completion threw.
    expect(mockSendKvittensNotification).toHaveBeenCalledTimes(1)
    expect(mockSendKvittensNotification).toHaveBeenCalledWith(expect.anything(), {
      companyId: 'comp-1',
      userId: 'user-1',
      kind: 'agi',
      period: expect.any(String),
      kvittensnummer: 'uuid-1',
      referenceId: 'decl-1',
    })

    // The failure is a warning (via the structured logger), not an error.
    expect(errorSpy).not.toHaveBeenCalled()
    expect(errorRecorder).not.toHaveBeenCalled()
    const warnMessages = warnRecorder.mock.calls.map(c => String(c[0]))
    expect(warnMessages.some(m => m.includes('completeTaxDeadline failed'))).toBe(true)
  })

  it('still reports signed when sendKvittensNotification throws', async () => {
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
    mockSendKvittensNotification.mockRejectedValueOnce(new Error('smtp down'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.signed).toBe(1)
    expect(body.errors).toBe(0)
    expect(body.results[0].status).toBe('signed')
    expect(errorSpy).not.toHaveBeenCalled()
    expect(errorRecorder).not.toHaveBeenCalled()
    const warnMessages = warnRecorder.mock.calls.map(c => String(c[0]))
    expect(warnMessages.some(m => m.includes('sendKvittensNotification failed'))).toBe(true)
  })

  it('counts grant_revoked in the run summary', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Ombud grant missing.', 'OMBUD_GRANT_MISSING'),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(1)
    expect(body.grantRevoked).toBe(1)
    expect(body.errors).toBe(0)
    expect(body.results[0]).toMatchObject({ status: 'grant_revoked', error: 'OMBUD_GRANT_MISSING' })
    expect(mockMarkGrantRevoked).toHaveBeenCalledWith('comp-1', expect.any(String), 'lasombud', 'OMBUD_GRANT_MISSING')

    const summaryLine = logSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('Processed'))
    expect(summaryLine).toContain('1 grants revoked')
  })

  it('treats ACCESS_DENIED as a real error now that the APIGW subscription is expected (#2226)', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Skatteverkets API-gateway nekade anropet.', 'ACCESS_DENIED'),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(1)
    expect(body.errors).toBe(1)
    // The old known-gap bucket is gone from the response contract.
    expect(body).not.toHaveProperty('apigwConfig')
    expect(body.results[0]).toMatchObject({
      declarationId: 'decl-1',
      status: 'error',
      // Machine-readable code, never the generic "Något gick fel" fallback.
      error: 'ACCESS_DENIED',
    })
    // companyId is internal log context, never response payload.
    expect(body.results[0]).not.toHaveProperty('companyId')

    // A gateway refusal is a regression, not a known gap: error level with
    // the gateway's message in context, no warn-once suppression, no
    // reconsent flagging.
    expect(errorRecorder).toHaveBeenCalledTimes(1)
    expect(String(errorRecorder.mock.calls[0][0])).toContain('Reconciliation failed')
    expect(errorRecorder.mock.calls[0][1]).toMatchObject({
      declarationId: 'decl-1',
      companyId: 'comp-1',
      message: 'Skatteverkets API-gateway nekade anropet.',
    })
    expect(warnSpy).not.toHaveBeenCalled()
    expect(warnRecorder).not.toHaveBeenCalled()
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()

    const summaryLine = logSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('Processed'))
    expect(summaryLine).toContain('1 errors')
    expect(summaryLine).not.toContain('apigw')
  })

  it('still flags reconsent codes as expired_token and marks the connection', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Sessionen har gått ut.', 'SESSION_EXPIRED'),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.expired).toBe(1)
    expect(body.results[0]).toMatchObject({ status: 'expired_token', error: 'SESSION_EXPIRED' })
    expect(mockMarkNeedsReconsent).toHaveBeenCalledWith(expect.anything(), 'user-1', 'comp-1', 'SESSION_EXPIRED')
    expect(errorSpy).not.toHaveBeenCalled()
    expect(errorRecorder).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(warnRecorder).not.toHaveBeenCalled()
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
    expect(errorRecorder).not.toHaveBeenCalled()
  })

  it('still logs at error level for other SkatteverketAuthError codes', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Du har inte behörighet.', 'BEHORIGHET_SAKNAS'),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    expect(body.results[0]).toMatchObject({ status: 'error', error: 'Du har inte behörighet.' })
    expect(errorRecorder).toHaveBeenCalledTimes(1)
    expect(String(errorRecorder.mock.calls[0][0])).toContain('Reconciliation failed')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(warnRecorder).not.toHaveBeenCalled()
  })

  it('still logs at error level for generic errors', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(new Error('fetch failed'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    expect(body.results[0]).toMatchObject({
      status: 'error',
      error: 'Något gick fel. Försök igen.',
    })
    expect(errorRecorder).toHaveBeenCalledTimes(1)
    expect(String(errorRecorder.mock.calls[0][0])).toContain('Reconciliation failed')
  })
})
