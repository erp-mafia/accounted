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
// observed via these recorders instead of console spies, the run summary
// included (infoRecorder). Console spies only assert nothing else leaks.
const { infoRecorder, warnRecorder, errorRecorder } = vi.hoisted(() => ({
  infoRecorder: vi.fn(),
  warnRecorder: vi.fn(),
  errorRecorder: vi.fn(),
}))

/** The structured run summary the route logs at the end of every run. */
function runSummary(): Record<string, unknown> | undefined {
  const call = infoRecorder.mock.calls.find((c: unknown[]) => c[0] === 'agi kvittens reconciliation run')
  return call?.[1] as Record<string, unknown> | undefined
}

vi.mock('@/lib/logger', () => {
  const logger = {
    info: infoRecorder,
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
      public readonly detail?: string,
    ) {
      super(message)
      this.name = 'SkatteverketAuthError'
    }
  }
  return {
    SkatteverketAuthError,
    // Same predicate as the real module: the reconciler turns this one
    // refusal into the gateway_refused outcome instead of letting it throw.
    isApigwClientRefusal: (err: unknown) =>
      err instanceof SkatteverketAuthError && err.detail === 'APIGW_CLIENT_REFUSED',
    // resolve-auth's currentSkvEnvironment (the ombud grant lookup) reads this.
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

// The real connection-store hits the DB via its own service client. The
// route itself no longer touches it; resolve-auth reads the ombud grant from
// here when system auth is on, and recordGrantRefusal stays mocked so a test
// can prove an AGI run never downgrades a grant.
vi.mock('@/extensions/general/skatteverket/lib/connection-store', () => ({
  getConnection: vi.fn().mockResolvedValue(null),
  keepRowsOnCurrentOrgNumber: vi.fn(async (rows: unknown[]) => rows),
}))

vi.mock('@/extensions/general/skatteverket/lib/grant-probe', () => ({
  recordGrantRefusal: vi.fn().mockResolvedValue('withdrawn'),
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
import { getConnection } from '@/extensions/general/skatteverket/lib/connection-store'
import { recordGrantRefusal } from '@/extensions/general/skatteverket/lib/grant-probe'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import { sendKvittensNotification } from '@/extensions/general/skatteverket/lib/kvittens-notification'

const mockCreateClient = vi.mocked(createClient)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockAgiGetKvittenser = vi.mocked(agiGetKvittenser)
const mockMarkNeedsReconsent = vi.mocked(markNeedsReconsent)
const mockGetConnection = vi.mocked(getConnection)
const mockRecordGrantRefusal = vi.mocked(recordGrantRefusal)
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
      for (const method of ['select', 'eq', 'in', 'gt', 'order', 'limit', 'update', 'delete', 'insert', 'upsert']) {
        chain[method] = vi.fn(() => chain)
      }
      // The wrap-round read of the rotating batch (id <= pivot): the first
      // read (id > pivot) already answered with every row the stub holds.
      let wrapRound = false
      chain.lte = vi.fn(() => {
        wrapRound = true
        return chain
      })
      chain.maybeSingle = vi.fn().mockResolvedValue(resolved)
      chain.single = vi.fn().mockResolvedValue(resolved)
      chain.then = (resolve: (v: unknown) => void) =>
        resolve(wrapRound ? { data: resolved.error ? null : [], error: resolved.error } : resolved)
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
    // The fixture kvittenser are signed 2026-06-01T10:00Z: run the cron a
    // quarter of an hour later, as production does. A kvittens first observed
    // weeks after signing is recorded without the email (reconciler tests).
    vi.useFakeTimers({ now: new Date('2026-06-01T10:15:00Z'), toFake: ['Date'] })
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
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
    // Tenant identifiers stay in internal log context only.
    expect(body.results[0]).not.toHaveProperty('companyId')
    // The kvittens read is audited; nobody asked, so the row names the token
    // owner whose personal token made the call, never a stand-in.
    expect(mockAgiGetKvittenser).toHaveBeenCalledTimes(1)
    expect(mockAgiGetKvittenser.mock.calls[0][3]).toEqual({ companyId: 'comp-1', userId: 'user-1' })
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

    // The row stays signed, but nothing retries the deadline once the
    // declaration is submitted: the failure reaches error tracking through
    // the structured logger (accounted#115), never raw console output.
    expect(errorSpy).not.toHaveBeenCalled()
    const errorMessages = errorRecorder.mock.calls.map(c => String(c[0]))
    expect(errorMessages.some(m => m.includes('completeTaxDeadline failed'))).toBe(true)
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

  describe('with ombud reads switched on', () => {
    const ENV_KEYS = ['SKATTEVERKET_SYSTEM_AUTH_MODE', 'SKATTEVERKET_SYSTEM_AUTH_MECHANISM'] as const
    let saved: Record<string, string | undefined>

    beforeEach(() => {
      saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
      process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'on'
      process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM = 'stub'
      // The company granted Accounted the skattekonto lasombud role, nothing
      // for arbetsgivardeklaration.
      mockGetConnection.mockResolvedValue({
        status: 'partial',
        lasombud_status: 'granted',
        moms_ombud_status: 'unknown',
      } as any)
    })

    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      mockGetConnection.mockResolvedValue(null)
    })

    it('reads the AGI kvittens on the member token, never on the lasombud grant', async () => {
      mockCreateClient.mockReturnValueOnce(stubHappyTables())
      mockAgiGetKvittenser.mockResolvedValueOnce({ ok: true, data: { kvittenser: [] } } as any)

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(body.results[0].status).toBe('still_pending')
      expect(mockAgiGetKvittenser).toHaveBeenCalledTimes(1)
      expect(mockAgiGetKvittenser.mock.calls[0][0]).toMatchObject({ mode: 'user', userId: 'user-1' })
    })

    it('an AGI refusal never revokes the skattekonto grant', async () => {
      mockCreateClient.mockReturnValueOnce(stubHappyTables())
      mockAgiGetKvittenser.mockRejectedValueOnce(
        new SkatteverketAuthError('Ombud grant missing.', 'OMBUD_GRANT_MISSING'),
      )

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(body.processed).toBe(1)
      expect(body.results[0].status).toBe('error')
      expect(mockRecordGrantRefusal).not.toHaveBeenCalled()
    })
  })

  // Production since July (#973, #2226): the gateway refuses the APIGW client
  // for the hantera API before it reads any bearer. 110 "Reconciliation
  // failed" errors in two days came from asking again per declaration, per tick.
  it('stops the run at the first gateway refusal of the APIGW client: one warn, no error, no further calls', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub({
        agi_declarations: {
          data: [
            PENDING_DECLARATION,
            { ...PENDING_DECLARATION, id: 'decl-2', company_id: 'comp-2', period_month: 6 },
            { ...PENDING_DECLARATION, id: 'decl-3', company_id: 'comp-3', period_month: 7 },
          ],
        },
        skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
        company_settings: { data: { org_number: '556123-4567', entity_type: 'aktiebolag' } },
      }),
    )
    mockAgiGetKvittenser.mockRejectedValue(
      new (SkatteverketAuthError as any)(
        'Skatteverkets API-gateway nekade anropet.',
        'ACCESS_DENIED',
        'APIGW_CLIENT_REFUSED',
      ),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    // Asked once, not three times: the answer cannot differ per declaration.
    expect(mockAgiGetKvittenser).toHaveBeenCalledTimes(1)
    expect(body.gatewayRefused).toBe(true)
    expect(body.processed).toBe(3)
    expect(body.errors).toBe(0)
    expect(body.results).toEqual([
      { declarationId: 'decl-1', period: '202605', status: 'gateway_refused' },
      { declarationId: 'decl-2', period: '202606', status: 'gateway_refused' },
      { declarationId: 'decl-3', period: '202607', status: 'gateway_refused' },
    ])

    // A standing operator-side state, not a fresh error per tick.
    expect(errorRecorder).not.toHaveBeenCalled()
    expect(warnRecorder).toHaveBeenCalledTimes(1)
    expect(String(warnRecorder.mock.calls[0][0])).toContain('gateway refuses the APIGW client')
    expect(warnRecorder.mock.calls[0][1]).toMatchObject({ issue: '#2226', route: 'direct', pending: 3 })
    // Nothing about the connection is wrong: no reconsent flag, no grant downgrade.
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()
    expect(mockRecordGrantRefusal).not.toHaveBeenCalled()

    expect(runSummary()).toMatchObject({ gatewayRefused: true })
  })

  it('a refusal of this installation\'s client does not starve a company that goes through the connector', async () => {
    // comp-2 is on the Skatteverket connector canary: its calls carry the
    // broker's gateway client, which the direct refusal says nothing about.
    const prev = {
      key: process.env.GNUBOK_CONNECTOR_KEY,
      oauth: process.env.SKATTEVERKET_OAUTH2_CLIENT_ID,
      canary: process.env.CONNECT_SKV_CANARY_COMPANIES,
    }
    process.env.GNUBOK_CONNECTOR_KEY = 'gnubok_ck_test'
    process.env.SKATTEVERKET_OAUTH2_CLIENT_ID = 'own-client'
    process.env.CONNECT_SKV_CANARY_COMPANIES = 'comp-2'
    try {
      mockCreateClient.mockReturnValueOnce(
        makeSupabaseStub({
          agi_declarations: {
            data: [
              PENDING_DECLARATION,
              { ...PENDING_DECLARATION, id: 'decl-2', company_id: 'comp-2', period_month: 6 },
              { ...PENDING_DECLARATION, id: 'decl-3', company_id: 'comp-3', period_month: 7 },
            ],
          },
          skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
          company_settings: { data: { org_number: '556123-4567', entity_type: 'aktiebolag' } },
        }),
      )
      mockAgiGetKvittenser
        .mockRejectedValueOnce(
          new (SkatteverketAuthError as any)('nekade anropet', 'ACCESS_DENIED', 'APIGW_CLIENT_REFUSED'),
        )
        .mockResolvedValueOnce({ ok: true, status: 200, data: { kvittenser: [] } } as any)

      const res = await GET(makeRequest())
      const body = await res.json()

      // decl-1 (direct) refused, decl-2 (connector) still asked, decl-3
      // (direct) answered from what the run already knows, without a call.
      expect(mockAgiGetKvittenser).toHaveBeenCalledTimes(2)
      expect(body.results.map((r: { declarationId: string; status: string }) => [r.declarationId, r.status])).toEqual([
        ['decl-1', 'gateway_refused'],
        ['decl-2', 'still_pending'],
        ['decl-3', 'gateway_refused'],
      ])
      expect(warnRecorder).toHaveBeenCalledTimes(1)
      expect(body.gatewayRefused).toBe(true)
    } finally {
      for (const [name, value] of [
        ['GNUBOK_CONNECTOR_KEY', prev.key],
        ['SKATTEVERKET_OAUTH2_CLIENT_ID', prev.oauth],
        ['CONNECT_SKV_CANARY_COMPANIES', prev.canary],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('reports gatewayRefused false on an ordinary run, so the first accepted call is visible', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockResolvedValueOnce({ ok: true, status: 200, data: { kvittenser: [] } } as any)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.gatewayRefused).toBe(false)
    expect(body.stillPending).toBe(1)
    expect(warnRecorder).not.toHaveBeenCalled()
  })

  it('keeps every other ACCESS_DENIED (kill switch, scope contract, generic 403) in the error path', async () => {
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

    // Untagged access denials are real failures, not suppressed and never a
    // reconsent flag: in the run's report by code (error level in the run
    // that opens a six-hour window; 10:15 does not), and the message on the
    // run's own log line.
    expect(errorRecorder).not.toHaveBeenCalled()
    expect(warnRecorder).toHaveBeenCalledWith('Reconciliation failed', expect.objectContaining({
      declarationId: 'decl-1',
      companyId: 'comp-1',
      message: 'Skatteverkets API-gateway nekade anropet.',
    }))
    expect(warnRecorder).toHaveBeenCalledWith('agi kvittens: declarations could not be reconciled (kinds: ACCESS_DENIED)', expect.objectContaining({
      failureKinds: { ACCESS_DENIED: 1 },
    }))
    expect(warnSpy).not.toHaveBeenCalled()
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()

    expect(runSummary()).toMatchObject({ errors: 1, failureKinds: { ACCESS_DENIED: 1 } })
    expect(JSON.stringify(runSummary())).not.toContain('apigw')
  })

  it('still flags reconsent codes as expired_token and marks the connection', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    // The verdict names the token it is about: whose, and which stored row.
    const expired = new SkatteverketAuthError('Sessionen har gått ut.', 'SESSION_EXPIRED')
    expired.tokenRow = { userId: 'user-7', version: { rowId: 'row-7', refreshCount: 3 } }
    mockAgiGetKvittenser.mockRejectedValueOnce(expired)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.expired).toBe(1)
    expect(body.results[0]).toMatchObject({ status: 'expired_token', error: 'SESSION_EXPIRED' })
    // That user's row, not one picked again, and only while it is that token:
    // a row another job refreshed meanwhile is not flagged.
    expect(mockMarkNeedsReconsent).toHaveBeenCalledWith(expect.anything(), 'user-7', 'comp-1', 'SESSION_EXPIRED', {
      rowId: 'row-7',
      refreshCount: 3,
    })
    expect(errorSpy).not.toHaveBeenCalled()
    expect(errorRecorder).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(warnRecorder).not.toHaveBeenCalled()
  })

  it('treats a token row gone mid-read as the next run\'s business, not a failure (another job was replacing it)', async () => {
    // storeTokens deletes, then inserts: a read in between finds no row. The
    // VAT and skattekonto crons already treat it this way.
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(new SkatteverketAuthError('Inte ansluten.', 'NOT_CONNECTED'))

    const body = await (await GET(makeRequest())).json()

    expect(body.results[0]).toMatchObject({ status: 'expired_token', error: 'NOT_CONNECTED' })
    expect(body.errors).toBe(0)
    expect(errorRecorder).not.toHaveBeenCalled()
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()
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

  it('reports other SkatteverketAuthError codes by code in the run report, at error level once per six hours', async () => {
    // It was an error per declaration on every run, 96 a day.
    const report = ['agi kvittens: declarations could not be reconciled (kinds: BEHORIGHET_SAKNAS)', {
      count: 1,
      failureKinds: { BEHORIGHET_SAKNAS: 1 },
      declarations: [{ declarationId: 'decl-1', companyId: 'comp-1', code: 'BEHORIGHET_SAKNAS' }],
    }]
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Du har inte behörighet.', 'BEHORIGHET_SAKNAS'),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    expect(body.results[0]).toMatchObject({ status: 'error', error: 'Du har inte behörighet.' })
    // 10:15 opens no six-hour window.
    expect(errorRecorder).not.toHaveBeenCalled()
    expect(warnRecorder).toHaveBeenCalledWith(...report)
    expect(runSummary()).toMatchObject({ errors: 1, failureKinds: { BEHORIGHET_SAKNAS: 1 } })
    expect(warnSpy).not.toHaveBeenCalled()

    vi.clearAllMocks()
    vi.setSystemTime(new Date('2026-06-01T18:00:03Z'))
    mockVerifyCronSecret.mockReturnValue(null)
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Du har inte behörighet.', 'BEHORIGHET_SAKNAS'),
    )
    await GET(makeRequest())
    expect(errorRecorder).toHaveBeenCalledTimes(1)
    expect(errorRecorder).toHaveBeenCalledWith(...report)
  })

  it('reads the batch from a random point in id order and wraps round, so no pending declaration is always behind the limit', async () => {
    // Oldest first with a limit of 100, a hundred declarations nobody signs
    // kept every newer one from ever being asked about.
    const stub = stubHappyTables()
    mockCreateClient.mockReturnValueOnce(stub)
    mockAgiGetKvittenser.mockResolvedValueOnce({ ok: true, status: 200, data: { kvittenser: [] } } as any)

    const body = await (await GET(makeRequest())).json()

    expect(body.stillPending).toBe(1)
    const reads = stub.from.mock.calls
      .map(([table]: [string], index: number) => (table === 'agi_declarations' ? stub.from.mock.results[index].value : null))
      .filter((chain: unknown) => chain !== null)
      .slice(0, 2)
    const pivot = reads[0].gt.mock.calls[0][1]
    expect(reads[0].gt.mock.calls).toEqual([['id', pivot]])
    expect(pivot).toMatch(/^[0-9a-f-]{36}$/)
    expect(reads[0].order.mock.calls).toEqual([['id', { ascending: true }]])
    expect(reads[0].limit.mock.calls).toEqual([[100]])
    // One row came back after the pivot: the rest of the batch is read from the start.
    expect(reads[1].lte.mock.calls).toEqual([['id', pivot]])
    expect(reads[1].limit.mock.calls).toEqual([[99]])
  })

  it('reports declarations the reconciler could not reconcile in one line per run, at error level once per six hours', async () => {
    // A pending declaration never expires: one Skatteverket keeps refusing
    // was an error on every run, 96 a day.
    const tables = () =>
      makeSupabaseStub({
        agi_declarations: {
          data: [PENDING_DECLARATION, { ...PENDING_DECLARATION, id: 'decl-2', period_month: 6 }],
        },
        skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
        company_settings: { data: { org_number: '556123-4567', entity_type: 'aktiebolag' } },
      })
    // Skatteverket's own text for a refused read; for an enskild firma it can
    // carry the arbetsgivare's personnummer, so only the status is logged.
    const failing = { ok: false, status: 500, error: 'Fel för arbetsgivare 191212121212' } as any
    const report = ['agi kvittens: declarations could not be reconciled (kinds: http_500)', {
      count: 2,
      failureKinds: { http_500: 2 },
      declarations: [
        { declarationId: 'decl-1', companyId: 'comp-1', httpStatus: 500 },
        { declarationId: 'decl-2', companyId: 'comp-1', httpStatus: 500 },
      ],
    }]

    // 10:15 opens no six-hour window: a warning, with the counts in the summary.
    mockCreateClient.mockReturnValueOnce(tables())
    mockAgiGetKvittenser.mockResolvedValueOnce(failing).mockResolvedValueOnce(failing)
    const body = await (await GET(makeRequest())).json()
    expect(body.errors).toBe(2)
    expect(errorRecorder).not.toHaveBeenCalled()
    expect(warnRecorder).toHaveBeenCalledWith(...report)
    expect(runSummary()).toMatchObject({ errors: 2, failureKinds: { http_500: 2 } })
    expect(JSON.stringify(warnRecorder.mock.calls)).not.toContain('191212121212')

    // 12:00, the run that opens a window: the same line at error level.
    vi.clearAllMocks()
    vi.setSystemTime(new Date('2026-06-01T12:00:04Z'))
    mockVerifyCronSecret.mockReturnValue(null)
    mockCreateClient.mockReturnValueOnce(tables())
    mockAgiGetKvittenser.mockResolvedValueOnce(failing).mockResolvedValueOnce(failing)
    await GET(makeRequest())
    expect(errorRecorder).toHaveBeenCalledTimes(1)
    expect(errorRecorder).toHaveBeenCalledWith(...report)
  })

  it('counts a company without a connection in the run summary without raising it: only its user can reconnect', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub({
        agi_declarations: { data: [PENDING_DECLARATION] },
        skatteverket_tokens: { data: [] },
        company_settings: { data: { org_number: '556123-4567', entity_type: 'aktiebolag' } },
      }),
    )

    const body = await (await GET(makeRequest())).json()

    expect(body.results[0]).toMatchObject({ status: 'no_token' })
    expect(runSummary()).toMatchObject({ noToken: 1, errors: 0 })
    expect(errorRecorder).not.toHaveBeenCalled()
  })

  it('starts no declaration after 30 s, so the slowest one (refresh 10 s, second look 1 s, call 15 s, writes) ends inside the 60 s limit', async () => {
    const twoPending = () =>
      makeSupabaseStub({
        agi_declarations: { data: [PENDING_DECLARATION, { ...PENDING_DECLARATION, id: 'decl-2', period_month: 6 }] },
        skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
        company_settings: { data: { org_number: '556123-4567', entity_type: 'aktiebolag' } },
      })
    // The first read takes `ms` of the run's clock.
    const slowRead = (ms: number) => async () => {
      vi.setSystemTime(Date.now() + ms)
      return { ok: true, status: 200, data: { kvittenser: [] } } as any
    }

    mockCreateClient.mockReturnValueOnce(twoPending())
    mockAgiGetKvittenser.mockImplementationOnce(slowRead(29_999)).mockImplementationOnce(slowRead(0))
    expect((await (await GET(makeRequest())).json()).processed).toBe(2)

    mockCreateClient.mockReturnValueOnce(twoPending())
    mockAgiGetKvittenser.mockImplementationOnce(slowRead(30_001))
    expect((await (await GET(makeRequest())).json()).processed).toBe(1)
    expect(mockAgiGetKvittenser).toHaveBeenCalledTimes(3)
  })

  it('reports a generic thrown failure by its name, never its message, at error level only in the run that opens a window', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockAgiGetKvittenser.mockRejectedValueOnce(new Error('fetch failed'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    expect(body.results[0]).toMatchObject({
      status: 'error',
      error: 'Något gick fel. Försök igen.',
    })
    expect(errorRecorder).not.toHaveBeenCalled()
    expect(warnRecorder).toHaveBeenCalledWith('agi kvittens: declarations could not be reconciled (kinds: Error)', {
      count: 1,
      failureKinds: { Error: 1 },
      declarations: [{ declarationId: 'decl-1', companyId: 'comp-1', code: 'Error' }],
    })
  })

  it('names the failure kinds in the message, so a new kind is its own group in error tracking', async () => {
    // One message for every kind put a TypeError from a bug in the same group
    // as a standing, perhaps muted, Skatteverket refusal.
    vi.setSystemTime(new Date('2026-06-01T06:05:00Z'))
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub({
        agi_declarations: { data: [PENDING_DECLARATION, { ...PENDING_DECLARATION, id: 'decl-2', period_month: 6 }] },
        skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
        company_settings: { data: { org_number: '556123-4567', entity_type: 'aktiebolag' } },
      }),
    )
    mockAgiGetKvittenser
      .mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'kvittenser')"))
      .mockRejectedValueOnce(new SkatteverketAuthError('Nekad.', 'ACCESS_DENIED'))

    await GET(makeRequest())

    expect(errorRecorder).toHaveBeenCalledTimes(1)
    expect(errorRecorder.mock.calls[0][0]).toBe('agi kvittens: declarations could not be reconciled (kinds: ACCESS_DENIED, TypeError)')
    // Names and codes only: the TypeError's message stays out of the report.
    expect(JSON.stringify(errorRecorder.mock.calls)).not.toContain('Cannot read properties')
  })
})
