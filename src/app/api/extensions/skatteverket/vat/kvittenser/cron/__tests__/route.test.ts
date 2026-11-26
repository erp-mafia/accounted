/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

// The route logs through '@/lib/logger' (accounted#115): its warn/error lines
// are observed through these recorders.
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

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn().mockReturnValue(null),
}))

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
    skvRequest: vi.fn(),
    skvRequestWithAuth: vi.fn(),
    getSkatteverketEnvironment: vi.fn(() => 'test'),
  }
})

vi.mock('@/extensions/general/skatteverket/lib/connection-store', () => ({
  getConnection: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/extensions/general/skatteverket/lib/grant-probe', () => ({
  recordGrantRefusal: vi.fn().mockResolvedValue('withdrawn'),
}))

vi.mock('@/extensions/general/skatteverket/lib/token-store', () => ({
  RECONSENT_ERROR_CODES: [
    'SESSION_EXPIRED',
    'REFRESH_EXHAUSTED',
    'MISSING_SCOPE',
    'TOKEN_CORRUPTED',
  ] as const,
  markNeedsReconsent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/extensions/general/skatteverket/lib/kvittens-notification', () => ({
  sendKvittensNotification: vi.fn().mockResolvedValue({ sent: true }),
}))

vi.mock('@/lib/vat/filing-record-store', () => ({
  recordVatFilingConfirmed: vi.fn().mockResolvedValue({ created: false, changed: true }),
}))

vi.mock('@/lib/deadlines/complete-tax-deadline', () => ({
  completeTaxDeadline: vi.fn().mockResolvedValue({ completed: 1 }),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: vi.fn().mockResolvedValue(true),
}))

// The company's own redovisare: the cron reads it, never the stored state's.
vi.mock('@/lib/company/org-number', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/org-number')>()),
  companyRedovisare: vi.fn().mockResolvedValue('165560000000'),
}))

import { GET } from '../route'
import { createClient } from '@supabase/supabase-js'
import { verifyCronSecret } from '@/lib/auth/cron'
import { skvRequestWithAuth, SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { sendKvittensNotification } from '@/extensions/general/skatteverket/lib/kvittens-notification'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import { recordVatFilingConfirmed } from '@/lib/vat/filing-record-store'
import { markNeedsReconsent } from '@/extensions/general/skatteverket/lib/token-store'
import { recordGrantRefusal } from '@/extensions/general/skatteverket/lib/grant-probe'
import { companyMembersChain } from '@/tests/helpers'

const mockCreateClient = vi.mocked(createClient)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockSkvRequest = vi.mocked(skvRequestWithAuth)
const mockSendKvittensNotification = vi.mocked(sendKvittensNotification)
const mockCompleteTaxDeadline = vi.mocked(completeTaxDeadline)
const mockRecordVatFilingConfirmed = vi.mocked(recordVatFilingConfirmed)
const mockMarkNeedsReconsent = vi.mocked(markNeedsReconsent)
const mockRecordGrantRefusal = vi.mocked(recordGrantRefusal)

function makeRequest() {
  return new Request('http://localhost/api/extensions/skatteverket/vat/kvittenser/cron', {
    headers: { authorization: 'Bearer test-secret' },
  })
}

const LOCKED_STATE = {
  status: 'draft_locked',
  redovisare: '165560000000',
  redovisningsperiod: '202606',
  periodType: 'monthly',
  year: 2026,
  period: 6,
  signeringsLank: 'https://skv.test/sign/abc',
}

function makeSupabaseStub(
  tables: Record<string, { data: unknown; error?: unknown; updateError?: unknown; updated?: unknown[] }>,
) {
  return {
    from: vi.fn((table: string) => {
      // Every token owner is still a member, unless a test says otherwise.
      if (table === 'company_members' && !tables.company_members) {
        const owners = ((tables.skatteverket_tokens?.data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id)
        return companyMembersChain(owners)
      }
      const result = tables[table] ?? { data: null, error: null }
      const resolved = { data: result.data, error: result.error ?? null }
      const chain: any = {}
      let isUpdate = false
      for (const method of ['select', 'eq', 'is', 'in', 'like', 'order', 'limit', 'range', 'delete', 'insert']) {
        chain[method] = vi.fn(() => chain)
      }
      chain.update = vi.fn(() => {
        isUpdate = true
        return chain
      })
      chain.maybeSingle = vi.fn().mockResolvedValue(resolved)
      chain.single = vi.fn().mockResolvedValue(resolved)
      // An update answers the rows it changed (`updated`, one row unless a
      // test says the compare-and-set missed) or `updateError`.
      chain.then = (resolve: (v: unknown) => void) =>
        resolve(
          !isUpdate
            ? resolved
            : result.updateError
              ? { data: null, error: result.updateError }
              : { data: result.updated ?? [{ id: 'row-1' }], error: null },
        )
      return chain
    }),
  } as any
}

function stubHappyTables(state: Record<string, unknown> = LOCKED_STATE) {
  return makeSupabaseStub({
    extension_data: {
      data: [{ company_id: 'comp-1', key: 'submission_202606', value: JSON.stringify(state) }],
    },
    skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
  })
}

describe('VAT kvittenser cron', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SKATTEVERKET_ENABLED = 'true'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    mockVerifyCronSecret.mockReturnValue(null)
    mockMarkNeedsReconsent.mockResolvedValue(undefined)
    mockRecordGrantRefusal.mockResolvedValue('withdrawn')
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A run on the schedule that does not open a six-hour window, so the
    // standing-failure report is a warning unless a test says otherwise
    // (cron-error-slot.ts decides on the run's start time alone).
    vi.useFakeTimers({ now: new Date('2026-07-01T08:30:00Z'), toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    errorSpy.mockRestore()
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('returns 401 when cron auth fails', async () => {
    mockVerifyCronSecret.mockReturnValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) as any,
    )
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('no-ops when the extension flag is off', async () => {
    process.env.SKATTEVERKET_ENABLED = 'false'
    const res = await GET(makeRequest())
    const body = await res.json()
    expect(body.processed).toBe(0)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('finds a locked draft behind more than 200 signed and saved states', async () => {
    // Signed and saved states are kept for good and sort first by updated_at:
    // a window over the oldest 200 rows never reached the locked one.
    const settled = Array.from({ length: 250 }, (_, i) => ({
      company_id: `comp-${i}`,
      key: 'submission_202605',
      value: JSON.stringify({ ...LOCKED_STATE, status: i % 2 ? 'signed' : 'draft_saved' }),
    }))
    mockCreateClient.mockReturnValueOnce(makeSupabaseStub({
      extension_data: {
        data: [...settled, { company_id: 'comp-late', key: 'submission_202609', value: JSON.stringify({ ...LOCKED_STATE, redovisningsperiod: '202609', period: 9 }) }],
      },
      skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
    }))
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-9', tidpunkt: '2026-10-12T10:00:00Z' }),
    } as any)

    const body = await (await GET(makeRequest())).json()

    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
    expect(body.results).toEqual([expect.objectContaining({ companyId: 'comp-late', period: '202609', status: 'signed' })])
  })

  it('marks the filing signed, records it on the moms deadline, and notifies', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-123', tidpunkt: '2026-07-01T10:00:00Z' }),
    } as any)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.signed).toBe(1)
    expect(body.errors).toBe(0)
    expect(body.results[0]).toMatchObject({ companyId: 'comp-1', period: '202606', status: 'signed' })
    // One audited read; nobody asked, so the row names the token owner whose
    // personal token made the call (a system-credential call would name no one).
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
    expect(mockSkvRequest.mock.calls[0][3]).toEqual({
      endpoint: 'inlamnat',
      companyId: 'comp-1',
      userId: 'user-1',
      agRegistreradId: '165560000000',
      redovisningsperiod: '202606',
      okStatuses: [404],
    })

    expect(mockRecordVatFilingConfirmed).toHaveBeenCalledWith(expect.anything(), 'comp-1', {
      periodType: 'monthly',
      year: 2026,
      period: 6,
    })
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: 'comp-1',
        userId: 'user-1',
        kind: 'vat',
        kvittensnummer: 'KV-123',
      }),
    )
    expect(errorRecorder).not.toHaveBeenCalled()
  })

  it('quarterly picker params record the quarter', async () => {
    mockCreateClient.mockReturnValueOnce(
      stubHappyTables({ ...LOCKED_STATE, periodType: 'quarterly', period: 2 }),
    )
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-456' }),
    } as any)

    await GET(makeRequest())

    expect(mockRecordVatFilingConfirmed).toHaveBeenCalledWith(expect.anything(), 'comp-1', {
      periodType: 'quarterly',
      year: 2026,
      period: 2,
    })
  })

  it('a failing filing record is logged and does not stop the notification', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-777' }),
    } as any)
    mockRecordVatFilingConfirmed.mockRejectedValueOnce(new Error('insert failed'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.signed).toBe(1)
    expect(mockSendKvittensNotification).toHaveBeenCalled()
    expect(errorRecorder).toHaveBeenCalledWith(
      'Failed to record filing on the moms deadline',
      expect.objectContaining({ companyId: 'comp-1', message: 'insert failed' }),
    )
    errorRecorder.mockClear()
  })

  it('yearly picker params record the filing through the same store as the other cadences', async () => {
    mockCreateClient.mockReturnValueOnce(
      stubHappyTables({ ...LOCKED_STATE, periodType: 'yearly', period: 12 }),
    )
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-999' }),
    } as any)

    await GET(makeRequest())

    // The store places the räkenskapsår from the company's settings; the
    // cron only names the period (year = the year it ends, period 1).
    expect(mockRecordVatFilingConfirmed).toHaveBeenCalledWith(expect.anything(), 'comp-1', {
      periodType: 'yearly',
      year: 2026,
      period: 1,
    })
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
  })

  it('legacy state without picker params still flips status but skips the deadline', async () => {
    const { periodType: _pt, year: _y, period: _p, ...legacyState } = LOCKED_STATE
    mockCreateClient.mockReturnValueOnce(stubHappyTables(legacyState))
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-789' }),
    } as any)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.signed).toBe(1)
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockRecordVatFilingConfirmed).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).toHaveBeenCalled()
  })

  it('records still_pending on 404 without touching state', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockSkvRequest.mockResolvedValueOnce({ ok: false, status: 404 } as any)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.stillPending).toBe(1)
    expect(body.signed).toBe(0)
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockRecordVatFilingConfirmed).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it("a locked draft naming another company's number is never asked about", async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables({ ...LOCKED_STATE, redovisare: '165599999999' }))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(body.signed).toBe(0)
    expect(mockRecordVatFilingConfirmed).not.toHaveBeenCalled()
  })

  it("the read names the company's own number in its 12-digit form", async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables({ ...LOCKED_STATE, redovisare: '556000-0000' }))
    mockSkvRequest.mockResolvedValueOnce({ ok: false, status: 404 } as any)

    await GET(makeRequest())

    expect(mockSkvRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      `/inlamnat/165560000000/${LOCKED_STATE.redovisningsperiod}`,
      expect.objectContaining({ agRegistreradId: '165560000000' })
    )
  })

  it('skips rows that are not draft_locked', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables({ ...LOCKED_STATE, status: 'draft_saved' }))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(0)
    expect(mockSkvRequest).not.toHaveBeenCalled()
  })

  it('flags reconsent codes as expired_token and marks the connection', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    // The verdict names the token it is about: whose, and which stored row.
    const expired = new SkatteverketAuthError('Sessionen har gått ut.', 'SESSION_EXPIRED')
    expired.tokenRow = { userId: 'user-7', version: { rowId: 'row-7', refreshCount: 3 } }
    mockSkvRequest.mockRejectedValueOnce(expired)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.expired).toBe(1)
    expect(body.results[0]).toMatchObject({ status: 'expired_token', error: 'SESSION_EXPIRED' })
    // That user's row, not one picked again, and only while it is that token.
    expect(mockMarkNeedsReconsent).toHaveBeenCalledWith(expect.anything(), 'user-7', 'comp-1', 'SESSION_EXPIRED', {
      rowId: 'row-7',
      refreshCount: 3,
    })

    // A verdict that names no token flags nothing: there is no row it is about.
    mockMarkNeedsReconsent.mockClear()
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockSkvRequest.mockRejectedValueOnce(new SkatteverketAuthError('Saknar behörighet.', 'MISSING_SCOPE'))
    await GET(makeRequest())
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()
  })

  it('starts at a random point in id order and wraps round, so a draft behind one still waiting is reached', async () => {
    // Oldest updated_at first, stopped by the budget, and a still-pending row
    // is never written: the same head was asked about on every run.
    const draft = (id: string, companyId: string) => ({ id, company_id: companyId, key: 'submission_202606', value: JSON.stringify(LOCKED_STATE) })
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub({
        extension_data: {
          data: [
            draft('11111111-0000-4000-8000-000000000000', 'comp-a'),
            draft('55555555-0000-4000-8000-000000000000', 'comp-b'),
            draft('99999999-0000-4000-8000-000000000000', 'comp-c'),
          ],
        },
        skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
      }),
    )
    mockSkvRequest.mockResolvedValue({ ok: false, status: 404 } as any)
    const pivot = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('44444444-0000-4000-8000-000000000000')

    const body = await (await GET(makeRequest())).json()

    expect(body.results.map((r: { companyId: string }) => r.companyId)).toEqual(['comp-b', 'comp-c', 'comp-a'])
    pivot.mockRestore()
    mockSkvRequest.mockReset()
  })

  it('records error for generic failures without aborting the run', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockSkvRequest.mockRejectedValueOnce(new Error('fetch failed'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    expect(body.results[0]).toMatchObject({
      status: 'error',
      error: 'Något gick fel. Försök igen, och kontakta support om det fortsätter.',
    })
    // Into the run's report by name, never by message; 08:30 opens no
    // six-hour window, so it is a warning (it was an error every run).
    expect(errorRecorder).not.toHaveBeenCalled()
    expect(warnRecorder).toHaveBeenCalledWith('vat kvittens: filings could not be checked at Skatteverket (kinds: Error)', {
      skatteverketErrors: {},
      grantRefused: 0,
      authErrors: {},
      thrown: { Error: 1 },
      companyIds: ['comp-1'],
    })
  })

  it('a failing signed-state update yields an error row and skips deadline + notification', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub({
        extension_data: {
          data: [{ company_id: 'comp-1', key: 'submission_202606', value: JSON.stringify(LOCKED_STATE) }],
          updateError: { message: 'connection reset', code: '08006' },
        },
        skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
      }),
    )
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-123' }),
    } as any)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.signed).toBe(0)
    expect(body.errors).toBe(1)
    expect(body.results[0]).toMatchObject({
      companyId: 'comp-1',
      period: '202606',
      status: 'error',
      error: 'Failed to persist signed state: connection reset',
    })
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockRecordVatFilingConfirmed).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
    expect(errorRecorder).toHaveBeenCalledTimes(1)
  })

  it("never checks a filing on the connection of someone who left the company, nor mails them", async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub({
        extension_data: { data: [{ company_id: 'comp-1', key: 'submission_202606', value: JSON.stringify(LOCKED_STATE) }] },
        skatteverket_tokens: { data: [{ user_id: 'user-left', status: 'active' }] },
        company_members: { data: [] },
      }),
    )

    const body = await (await GET(makeRequest())).json()

    expect(body.results).toEqual([{ companyId: 'comp-1', period: '202606', status: 'no_token' }])
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('flips the state only if the row is still the one it read, and leaves a state changed meanwhile alone', async () => {
    const READ_AT = '2026-07-01T09:00:00.123456+00:00'
    const SIGNED = { ok: true, status: 200, json: async () => ({ kvittensnummer: 'KV-123' }) } as any
    const stub = (updated?: unknown[]) =>
      makeSupabaseStub({
        extension_data: {
          data: [{ company_id: 'comp-1', key: 'submission_202606', value: JSON.stringify(LOCKED_STATE), updated_at: READ_AT }],
          ...(updated ? { updated } : {}),
        },
        skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
      })
    const updateChain = (client: any) =>
      client.from.mock.results.map((r: any) => r.value).find((chain: any) => chain.update?.mock.calls.length > 0)

    // Unchanged since the read: the write goes through, guarded on updated_at.
    const untouched = stub()
    mockCreateClient.mockReturnValueOnce(untouched)
    mockSkvRequest.mockResolvedValueOnce(SIGNED)
    const first = await (await GET(makeRequest())).json()
    expect(first.results[0]).toMatchObject({ status: 'signed' })
    expect(updateChain(untouched).eq.mock.calls).toContainEqual(['updated_at', READ_AT])

    // The user locked a new draft (or the panel stored the kvittens) after
    // the read: the write matches no row, and nothing is completed or mailed
    // from the old snapshot.
    vi.clearAllMocks()
    mockVerifyCronSecret.mockReturnValue(null)
    mockCreateClient.mockReturnValueOnce(stub([]))
    mockSkvRequest.mockResolvedValueOnce(SIGNED)
    const second = await (await GET(makeRequest())).json()
    expect(second.results[0]).toMatchObject({ companyId: 'comp-1', status: 'state_changed' })
    expect(second.signed).toBe(0)
    expect(mockRecordVatFilingConfirmed).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
    expect(errorRecorder).not.toHaveBeenCalled()
  })

  it('reports the reads Skatteverket failed or refused once per run with counts, not in the response body alone', async () => {
    const row = (companyId: string) => ({ company_id: companyId, key: 'submission_202606', value: JSON.stringify(LOCKED_STATE) })
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub({
        extension_data: { data: ['comp-1', 'comp-2', 'comp-3', 'comp-4'].map(row) },
        skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
      }),
    )
    mockSkvRequest
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upstream' } as any)
      .mockRejectedValueOnce(new SkatteverketAuthError('Ombud saknas.', 'OMBUD_GRANT_MISSING'))
      .mockRejectedValueOnce(new SkatteverketAuthError('Nekad.', 'ACCESS_DENIED'))
      // The user revoked the token at Skatteverket: a state, not a failure.
      .mockRejectedValueOnce(new SkatteverketAuthError('Återkallad.', 'TOKEN_REVOKED'))

    const body = await (await GET(makeRequest())).json()

    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['error', 'error', 'expired_token', 'expired_token'])
    // The kinds in the message, sorted: error tracking groups by it.
    const report = ['vat kvittens: filings could not be checked at Skatteverket (kinds: ACCESS_DENIED, OMBUD_GRANT_MISSING, http_500)', {
      skatteverketErrors: { '500': 1 },
      grantRefused: 1,
      authErrors: { ACCESS_DENIED: 1 },
      thrown: {},
      companyIds: ['comp-1', 'comp-2', 'comp-3'],
    }]
    // 08:30 opens no six-hour window: a warning, which reaches nobody.
    expect(errorRecorder).not.toHaveBeenCalled()
    expect(warnRecorder).toHaveBeenCalledWith(...report)
  })

  it('raises the same failures at error level in the run that opens a six-hour window, not in every run', async () => {
    // A declaration that keeps failing stays locked: at error level on every
    // run it was twelve identical reports a day.
    const row = (companyId: string) => ({ company_id: companyId, key: 'submission_202606', value: JSON.stringify(LOCKED_STATE) })
    vi.setSystemTime(new Date('2026-07-01T06:30:00Z'))
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub({
        extension_data: { data: [row('comp-1')] },
        skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
      }),
    )
    mockSkvRequest.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad request' } as any)

    await GET(makeRequest())

    expect(errorRecorder).toHaveBeenCalledTimes(1)
    expect(errorRecorder).toHaveBeenCalledWith('vat kvittens: filings could not be checked at Skatteverket (kinds: http_400)', {
      skatteverketErrors: { '400': 1 },
      grantRefused: 0,
      authErrors: {},
      thrown: {},
      companyIds: ['comp-1'],
    })
  })

  function stubTwoCompanyTables() {
    return makeSupabaseStub({
      extension_data: {
        data: [
          { company_id: 'comp-1', key: 'submission_202606', value: JSON.stringify(LOCKED_STATE) },
          { company_id: 'comp-2', key: 'submission_202606', value: JSON.stringify(LOCKED_STATE) },
        ],
      },
      skatteverket_tokens: { data: [{ user_id: 'user-1', status: 'active' }] },
    })
  }

  it('a refused moms read asks the register about the grant instead of revoking it (#115)', async () => {
    mockCreateClient.mockReturnValueOnce(stubTwoCompanyTables())
    mockSkvRequest
      .mockRejectedValueOnce(new SkatteverketAuthError('Ombud saknas.', 'OMBUD_GRANT_MISSING'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ kvittensnummer: 'KV-123' }) } as any)

    const body = await (await GET(makeRequest())).json()

    expect(mockRecordGrantRefusal).toHaveBeenCalledTimes(1)
    expect(mockRecordGrantRefusal).toHaveBeenCalledWith('comp-1', 'moms_ombud')
    expect(body.results[0]).toMatchObject({ companyId: 'comp-1', status: 'error', error: 'OMBUD_GRANT_MISSING' })
  })

  it('a throwing recordGrantRefusal does not abort the remaining companies', async () => {
    mockCreateClient.mockReturnValueOnce(stubTwoCompanyTables())
    mockSkvRequest
      .mockRejectedValueOnce(new SkatteverketAuthError('Ombud saknas.', 'OMBUD_GRANT_MISSING'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ kvittensnummer: 'KV-123' }),
      } as any)
    mockRecordGrantRefusal.mockRejectedValueOnce(new Error('db outage'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(2)
    expect(body.results[0]).toMatchObject({
      companyId: 'comp-1',
      status: 'error',
      error: 'OMBUD_GRANT_MISSING',
    })
    expect(body.results[1]).toMatchObject({ companyId: 'comp-2', status: 'signed' })
    expect(mockRecordGrantRefusal).toHaveBeenCalledTimes(1)
    expect(warnRecorder).toHaveBeenCalledWith('Failed to record the grant refusal', expect.objectContaining({ companyId: 'comp-1' }))
  })

  it('starts no row after 30 s, so the slowest one (refresh 10 s, second look 1 s, call 15 s, writes, mail) ends inside the 60 s limit', async () => {
    // The first read takes `ms` of the run's clock.
    const slowRead = (ms: number) => async () => {
      vi.setSystemTime(Date.now() + ms)
      return { ok: false, status: 404 } as any
    }

    mockCreateClient.mockReturnValueOnce(stubTwoCompanyTables())
    mockSkvRequest.mockImplementationOnce(slowRead(29_999)).mockImplementationOnce(slowRead(0))
    expect((await (await GET(makeRequest())).json()).processed).toBe(2)

    mockCreateClient.mockReturnValueOnce(stubTwoCompanyTables())
    mockSkvRequest.mockImplementationOnce(slowRead(30_001))
    expect((await (await GET(makeRequest())).json()).processed).toBe(1)
    expect(mockSkvRequest).toHaveBeenCalledTimes(3)
  })

  it('a throwing markNeedsReconsent does not abort the remaining companies', async () => {
    mockCreateClient.mockReturnValueOnce(stubTwoCompanyTables())
    const expired = new SkatteverketAuthError('Sessionen har gått ut.', 'SESSION_EXPIRED')
    expired.tokenRow = { userId: 'user-1' }
    mockSkvRequest
      .mockRejectedValueOnce(expired)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ kvittensnummer: 'KV-456' }),
      } as any)
    mockMarkNeedsReconsent.mockRejectedValueOnce(new Error('network blip'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(2)
    expect(body.results[0]).toMatchObject({
      companyId: 'comp-1',
      status: 'expired_token',
      error: 'SESSION_EXPIRED',
    })
    expect(body.results[1]).toMatchObject({ companyId: 'comp-2', status: 'signed' })
    expect(warnRecorder).toHaveBeenCalledTimes(1)
  })
})
