/**
 * The Skatteverket transport writes exactly one skatteverket_api_audit_log row
 * per outbound call (founder decision D4: every call, reads included), and no
 * route writes one on top. The routes run here against the REAL transport and
 * AGI client; only fetch, the token store and the audit insert are stubbed,
 * so "one row per call" is counted, not assumed.
 *
 * The reset guards read three labels with outcome 'ok': 'declaration/lock',
 * 'declaration/submit' and 'agi/submit'. Those strings are pinned below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const records = vi.hoisted(
  () => [] as Parameters<typeof import('@/lib/logger').createTestLogger>[1],
)
const auditMock = vi.hoisted(() => vi.fn())
const getTokensMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return { ...actual, createLogger: (module: string) => actual.createTestLogger(module, records) }
})

vi.mock('../lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/audit')>()
  return { ...actual, writeSkatteverketAudit: (...a: unknown[]) => auditMock(...a) }
})

vi.mock('../lib/token-store', () => ({
  getTokens: (...a: unknown[]) => getTokensMock(...a),
  storeTokens: vi.fn(),
  deleteTokens: vi.fn(),
}))

vi.mock('../lib/system-auth/token-provider', () => ({
  getSystemAccessToken: vi.fn(async () => 'system-bearer'),
  invalidateSystemToken: vi.fn(),
}))

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})

vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_s: unknown, _c: unknown, _k: unknown, run: () => Promise<unknown>) => run(),
}))

const REDOVISARE = '165560000000'
const PERIOD = '202606'

vi.mock('../lib/declaration-prep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/declaration-prep')>()
  return {
    ...actual,
    buildMomsuppgift: vi.fn(async () => ({
      redovisare: REDOVISARE,
      redovisningsperiod: PERIOD,
      momsuppgift: { momsUtgHog: 2500 },
    })),
    buildAgiUnderlag: vi.fn(async () => ({
      arbetsgivare: REDOVISARE,
      period: PERIOD,
      salaryRunId: 'run-1',
      xml: '<Skatteverket/>',
      periodYear: 2026,
      periodMonth: 6,
    })),
  }
})

import type { ExtensionContext } from '@/lib/extensions/types'
import { skatteverketExtension } from '../index'
import { skvRequestWithAuth, SkatteverketAuthError } from '../lib/api-client'

/** Upstream answers, consumed in call order. */
let answers: Array<Response | Error> = []
const fetchMock = vi.fn(async () => {
  const next = answers.shift()
  if (!next) throw new Error('unexpected extra Skatteverket call')
  if (next instanceof Error) throw next
  return next
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A chainable, awaitable Supabase stub: owner role, no rows anywhere else. */
function makeSupabase() {
  const from = vi.fn((table: string) => {
    const result = table === 'company_members' ? { data: { role: 'owner' }, error: null } : { data: null, error: null }
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'like', 'order', 'limit', 'update', 'upsert', 'insert', 'delete', 'is', 'gte', 'lte']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.maybeSingle = vi.fn(async () => result)
    chain.single = vi.fn(async () => result)
    chain.then = (resolve: (v: unknown) => void) => resolve(result)
    return chain
  })
  return { from, rpc: vi.fn(async () => ({ data: null, error: null })) }
}

function makeContext(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req-transport-audit',
    supabase: makeSupabase(),
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ExtensionContext
}

function route(method: string, path: string) {
  const found = skatteverketExtension.apiRoutes?.find((r) => r.method === method && r.path === path)
  if (!found) throw new Error(`route ${method} ${path} not registered`)
  return found
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`https://test.local/api/extensions/ext/skatteverket${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Every audit row written: its actor plus its fields. */
function rows(): Array<Record<string, unknown>> {
  return auditMock.mock.calls.map(([actor, fields]) => ({ actor, ...(fields as Record<string, unknown>) }))
}

beforeEach(() => {
  vi.clearAllMocks()
  records.length = 0
  answers = []
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('SKATTEVERKET_DISABLED', '')
  vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', 'gw-id')
  vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_SECRET', 'gw-secret')
  vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
  vi.stubEnv('CONNECT_SKV_CANARY_COMPANIES', '')
  getTokensMock.mockResolvedValue({
    access_token: 'user-bearer',
    refresh_token: 'user-refresh',
    expires_at: Date.now() + 60 * 60_000,
    refresh_count: 0,
    scope: 'momsdeklaration agd agdredovisningperiod',
  })
  auditMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('transport: one audit row per outbound call', () => {
  const USER = { mode: 'user' as const, supabase: {} as never, userId: 'user-1', companyId: 'company-1' }
  const TARGET = { endpoint: 'probe', companyId: 'company-1', userId: 'user-1' }

  it('records a 2xx as ok with status, correlation id and request size', async () => {
    answers = [json(200, { ok: true })]
    await skvRequestWithAuth(USER, 'POST', '/x', { ...TARGET, agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD }, { a: 1 })

    expect(rows()).toEqual([
      expect.objectContaining({
        actor: { companyId: 'company-1', userId: 'user-1' },
        endpoint: 'probe',
        agRegistreradId: REDOVISARE,
        redovisningsperiod: PERIOD,
        outcome: 'ok',
        responseStatus: 200,
        requestSizeBytes: Buffer.byteLength('{"a":1}'),
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    ])
  })

  it('records any other answer as skv_error with a bounded body excerpt, and still returns it', async () => {
    answers = [json(400, { kod: 'FEL' })]
    const res = await skvRequestWithAuth(USER, 'GET', '/x', TARGET)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ kod: 'FEL' })
    expect(rows()).toEqual([
      expect.objectContaining({ outcome: 'skv_error', responseStatus: 400, errorMessage: '{"kod":"FEL"}' }),
    ])
  })

  it('records an okStatuses answer as ok (404 nothing on file)', async () => {
    answers = [new Response('', { status: 404 })]
    await skvRequestWithAuth(USER, 'GET', '/x', { ...TARGET, okStatuses: [404], expectJson: true })
    expect(rows()).toEqual([expect.objectContaining({ outcome: 'ok', responseStatus: 404 })])
  })

  it('reads skv_status through skvStatusOf, and a non-JSON answer it needs is skv_error', async () => {
    const skvStatusOf = (body: unknown) => (body as { status: string }).status
    answers = [json(200, { status: 'DONE_SUCCESS' }), new Response('not json', { status: 200 })]
    await skvRequestWithAuth(USER, 'GET', '/x', { ...TARGET, skvStatusOf })
    await skvRequestWithAuth(USER, 'GET', '/x', { ...TARGET, skvStatusOf })
    expect(rows()).toEqual([
      expect.objectContaining({ outcome: 'ok', skvStatus: 'DONE_SUCCESS' }),
      expect.objectContaining({ outcome: 'skv_error', responseStatus: 200 }),
    ])
  })

  it('records a 2xx that is not JSON as skv_error when the caller expects JSON', async () => {
    answers = [new Response('', { status: 200 })]
    await skvRequestWithAuth(USER, 'GET', '/x', { ...TARGET, expectJson: true })
    expect(rows()).toEqual([expect.objectContaining({ outcome: 'skv_error', responseStatus: 200 })])
  })

  it('records a mapped 401/403/429 as auth_error and rethrows', async () => {
    answers = [new Response('', { status: 429 })]
    await expect(skvRequestWithAuth(USER, 'GET', '/x', TARGET)).rejects.toBeInstanceOf(SkatteverketAuthError)
    expect(rows()).toEqual([
      expect.objectContaining({ outcome: 'auth_error', responseStatus: 429, errorMessage: expect.any(String) }),
    ])
  })

  it('records a network failure as internal_error with no status, and rethrows', async () => {
    answers = [new Error('socket hang up')]
    await expect(skvRequestWithAuth(USER, 'GET', '/x', TARGET)).rejects.toThrow('socket hang up')
    expect(rows()).toEqual([
      expect.objectContaining({ outcome: 'internal_error', responseStatus: null, errorMessage: 'socket hang up' }),
    ])
  })

  it('writes no row when nothing left: no token, or the kill switch', async () => {
    getTokensMock.mockResolvedValueOnce(null)
    await expect(skvRequestWithAuth(USER, 'GET', '/x', TARGET)).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    vi.stubEnv('SKATTEVERKET_DISABLED', 'true')
    await expect(skvRequestWithAuth(USER, 'GET', '/x', TARGET)).rejects.toBeInstanceOf(SkatteverketAuthError)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(auditMock).not.toHaveBeenCalled()
  })

  it('records a system call no user started with a null user', async () => {
    answers = [json(200, {})]
    await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', { endpoint: 'kvittenser', companyId: 'company-1', userId: null })
    expect(rows()).toEqual([
      expect.objectContaining({ actor: { companyId: 'company-1', userId: null }, endpoint: 'kvittenser', outcome: 'ok' }),
    ])
  })

  it('logs a company-less register call instead of writing a row', async () => {
    answers = [json(200, [])]
    await skvRequestWithAuth({ mode: 'system' }, 'GET', '/roller', { unaudited: 'ombud_register', operation: 'roller' })
    expect(auditMock).not.toHaveBeenCalled()
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'info',
        msg: 'ombud register call (no company, not in the audit table)',
        operation: 'roller',
        outcome: 'ok',
        responseStatus: 200,
      }),
    )
  })
})

describe('routes: exactly one row per outbound call, with its label', () => {
  const agiPeriod = `arbetsgivare=${REDOVISARE}&period=${PERIOD}`
  const cases: Array<{
    name: string
    method: string
    path: string
    url: string
    body?: unknown
    answer: () => Response
    endpoint: string
    scope: { agRegistreradId: string | null; redovisningsperiod: string | null }
    skvStatus?: string
  }> = [
    {
      name: 'VAT check',
      method: 'POST', path: '/declaration/validate', url: '/declaration/validate',
      body: { periodType: 'monthly', year: 2026, period: 6 },
      answer: () => json(200, { kontrollResultat: { resultat: [] } }),
      endpoint: 'declaration/validate',
      scope: { agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD },
    },
    {
      name: 'VAT draft',
      method: 'POST', path: '/declaration/draft', url: '/declaration/draft',
      body: { periodType: 'monthly', year: 2026, period: 6 },
      answer: () => json(200, { kontrollresultat: null }),
      endpoint: 'declaration/draft',
      scope: { agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD },
    },
    {
      name: 'VAT lock',
      method: 'PUT', path: '/declaration/lock',
      url: `/declaration/lock?redovisare=${REDOVISARE}&redovisningsperiod=${PERIOD}`,
      answer: () => json(200, { signeringsLank: 'https://skv.test/sign' }),
      endpoint: 'declaration/lock',
      scope: { agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD },
    },
    {
      name: 'AGI submit',
      method: 'POST', path: '/agi/submit', url: '/agi/submit',
      body: { salaryRunId: 'run-1' },
      answer: () => json(200, { inlamningId: 7 }),
      endpoint: 'agi/submit',
      scope: { agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD },
    },
    {
      name: 'AGI kontrollresultat',
      method: 'GET', path: '/agi/kontrollresultat', url: '/agi/kontrollresultat?inlamningId=7',
      answer: () => json(200, { status: 'DONE_SUCCESS' }),
      endpoint: 'agi/kontrollresultat',
      scope: { agRegistreradId: null, redovisningsperiod: null },
      skvStatus: 'DONE_SUCCESS',
    },
    {
      name: 'AGI spara',
      method: 'POST', path: '/agi/spara', url: '/agi/spara',
      body: { inlamningId: 7, salaryRunId: 'run-1' },
      answer: () => json(200, {}),
      endpoint: 'agi/spara',
      scope: { agRegistreradId: null, redovisningsperiod: null },
    },
    {
      name: 'AGI avbryt',
      method: 'DELETE', path: '/agi/underlag', url: `/agi/underlag?inlamningId=7&period=${PERIOD}`,
      answer: () => new Response(null, { status: 204 }),
      endpoint: 'agi/avbryt',
      scope: { agRegistreradId: null, redovisningsperiod: PERIOD },
    },
    {
      name: 'AGI ta bort sparad',
      method: 'DELETE', path: '/agi/sparad', url: `/agi/sparad?${agiPeriod}&inlamningId=7`,
      answer: () => new Response(null, { status: 204 }),
      endpoint: 'agi/sparad/ta-bort',
      scope: { agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD },
    },
    {
      name: 'AGI granskningsunderlag',
      method: 'POST', path: '/agi/granskningsunderlag', url: `/agi/granskningsunderlag?${agiPeriod}`,
      answer: () => json(200, { link: 'https://skv.test/agi', tillstand: 'LOCKED_FOR_SIGNING' }),
      endpoint: 'agi/granskningsunderlag',
      scope: { agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD },
      skvStatus: 'LOCKED_FOR_SIGNING',
    },
    {
      name: 'AGI kvittenser',
      method: 'GET', path: '/agi/kvittenser', url: `/agi/kvittenser?${agiPeriod}`,
      answer: () => json(200, { kvittenser: [] }),
      endpoint: 'kvittenser',
      scope: { agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD },
    },
    {
      name: 'AGI las',
      method: 'POST', path: '/agi/las', url: `/agi/las?${agiPeriod}`,
      answer: () => json(200, {}),
      endpoint: 'agi/las',
      scope: { agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD },
    },
    {
      name: 'AGI lasUpp',
      method: 'POST', path: '/agi/lasUpp', url: `/agi/lasUpp?${agiPeriod}`,
      answer: () => json(200, {}),
      endpoint: 'agi/lasUpp',
      scope: { agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD },
    },
    {
      name: 'AGI kontrollera HU',
      method: 'POST', path: '/agi/kontrollera/hu', url: '/agi/kontrollera/hu',
      body: { agRegistreradId: REDOVISARE, redovisningsPeriod: PERIOD, summaSkatteavdr: 8200 },
      answer: () => json(200, { status: 'OK', fel: [] }),
      endpoint: 'agi.kontrollera.hu',
      scope: { agRegistreradId: REDOVISARE, redovisningsperiod: PERIOD },
      skvStatus: 'OK',
    },
  ]

  it.each(cases)('$name: one row labelled $endpoint', async (c) => {
    answers = [c.answer()]
    const res = await route(c.method, c.path).handler(request(c.method, c.url, c.body), makeContext())

    expect(res.status).toBeLessThan(300)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual([
      expect.objectContaining({
        actor: { companyId: 'company-1', userId: 'user-1' },
        endpoint: c.endpoint,
        ...c.scope,
        outcome: 'ok',
        skvStatus: c.skvStatus ?? null,
      }),
    ])
  })

  it('one-click VAT submit: three calls, three rows, none labelled declaration/submit', async () => {
    answers = [
      json(200, { kontrollResultat: { resultat: [] } }),
      json(200, { kontrollResultat: { resultat: [] } }),
      json(200, { signeringsLank: 'https://skv.test/sign' }),
    ]
    const res = await route('POST', '/declaration/submit').handler(
      request('POST', '/declaration/submit', { periodType: 'monthly', year: 2026, period: 6 }),
      makeContext(),
    )

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(rows().map((r) => [r.endpoint, r.outcome])).toEqual([
      ['declaration/validate', 'ok'],
      ['declaration/draft', 'ok'],
      ['declaration/lock', 'ok'],
    ])
    // Filing is the user's BankID signature after the lock, not a call we
    // make: the guard term on 'declaration/submit' keeps never matching.
    expect(rows().some((r) => r.endpoint === 'declaration/submit')).toBe(false)
  })

  it('a refused lock is one skv_error row, never an ok guard row', async () => {
    answers = [new Response('already locked', { status: 409 })]
    const res = await route('PUT', '/declaration/lock').handler(
      request('PUT', `/declaration/lock?redovisare=${REDOVISARE}&redovisningsperiod=${PERIOD}`),
      makeContext(),
    )
    expect(res.status).toBe(409)
    expect(rows()).toEqual([
      expect.objectContaining({ endpoint: 'declaration/lock', outcome: 'skv_error', responseStatus: 409 }),
    ])
  })

  it('AGI commit service: one row per call, every kontrollresultat poll included', async () => {
    const commitSubmitAgi = skatteverketExtension.services!.commitSubmitAgi as unknown as (
      s: unknown, u: string, c: string, p: Record<string, unknown>,
    ) => Promise<{ ok: boolean }>
    vi.stubEnv('SKATTEVERKET_ENABLED', 'true')
    answers = [
      json(200, { inlamningId: 7 }),
      json(200, { status: 'PROCESSING' }),
      json(200, { status: 'DONE_SUCCESS' }),
      json(200, { link: 'https://skv.test/agi', tillstand: 'LOCKED_FOR_SIGNING' }),
    ]

    const result = await commitSubmitAgi(makeSupabase(), 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(rows().map((r) => [r.endpoint, r.outcome, r.skvStatus])).toEqual([
      ['agi/submit', 'ok', null],
      ['agi/kontrollresultat', 'ok', 'PROCESSING'],
      ['agi/kontrollresultat', 'ok', 'DONE_SUCCESS'],
      ['agi/granskningsunderlag', 'ok', 'LOCKED_FOR_SIGNING'],
    ])
  }, 10_000)
})
