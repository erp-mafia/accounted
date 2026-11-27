import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTRACT_VERSION,
  SPEND_OPERATIONS,
  type SpendConnection,
  type SpendExpense,
  type SpendOperation,
  type SpendProvider,
} from '@accounted/connect-contract'
import {
  SPEND_ACTION_REQUIRED_CODES,
  SPEND_CONNECT_PROTOCOL_ERROR,
  SPEND_CONNECT_UNCONFIGURED,
  SPEND_CONNECT_UNREACHABLE,
  SpendConnectError,
  acknowledgeSpendExpenses,
  authorizeSpend,
  completeSpendConnect,
  connectSpendWithKey,
  disconnectSpendConnection,
  fetchSpendExpenses,
  fetchSpendStatus,
  isSpendConnectConfigured,
  listSpendProviders,
  sendSpendMasterData,
  type SpendConnectDeps,
} from '../connect-client'

const CONFIG = { baseUrl: 'https://connect.example.se', key: 'gnubok_ck_test_key_value_123456' }
const COMPANY = '7f1c2e3a-4b5d-4c6e-8f70-9a1b2c3d4e5f'
const HANDLE = 'spend_handle_abcdefghijklmnop'
const SERVER_TIME = '2026-10-17T10:00:00Z'

const PROVIDER: SpendProvider = {
  ref: 'pleo',
  displayName: 'Pleo',
  legalName: 'Pleo Technologies A/S',
  portalUrl: 'https://app.pleo.io',
  supportUrl: null,
  connectModes: ['oauth', 'api_key'],
  maxDimensions: 5,
  setupNoteSv: null,
}

const CONNECTION: SpendConnection = {
  connectionHandle: 'spend_' + 'x'.repeat(40),
  provider: PROVIDER,
  mode: 'oauth',
  providerCompanyRef: 'pleo-company-1',
  providerCompanyName: 'Exempel AB',
  providerOrgNumber: '5566778899',
  connectedAt: SERVER_TIME,
}

const EXPENSE: SpendExpense = {
  externalId: 'exp-1',
  batchRef: null,
  kind: 'card_purchase',
  subKind: null,
  date: '2026-10-15',
  currency: 'SEK',
  amount: 125,
  original: null,
  walletAccount: '1940',
  lines: [{ account: '5410', amount: 125, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 25 }, dimensions: {}, description: null }],
  merchant: { name: 'Kontorsbutiken AB', country: 'SE', taxId: null, categoryCode: null },
  person: { name: 'Anna Andersson', ref: null },
  note: null,
  attendees: [],
  reference: null,
  settles: [],
  files: [],
  providerUrl: null,
  issues: [],
  raw: { contentType: 'application/json', body: '{"id":"exp-1"}', sha256: 'a'.repeat(64) },
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }))
}

function deps(fetchImpl: ReturnType<typeof vi.fn>, config: SpendConnectDeps['config'] = CONFIG): SpendConnectDeps {
  return { config, fetch: fetchImpl as unknown as typeof fetch }
}

function lastCall(fetchImpl: ReturnType<typeof vi.fn>): { url: string; init: RequestInit; headers: Record<string, string>; body: unknown } {
  const [url, init] = fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit]
  return { url, init, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('the spend Connect client', () => {
  // Every operation: its answer, the call that makes it, and the body it must send.
  const cases: Array<{ operation: SpendOperation; answer: unknown; run: (d: SpendConnectDeps) => Promise<unknown>; body: unknown }> = [
    {
      operation: 'providers',
      answer: { providers: [PROVIDER], serverTime: SERVER_TIME },
      run: (d) => listSpendProviders(COMPANY, d),
      body: {},
    },
    {
      operation: 'authorize',
      answer: { authorizeUrl: 'https://auth.pleo.io/oauth/authorize?client_id=x', expiresAt: SERVER_TIME },
      run: (d) =>
        authorizeSpend(
          COMPANY,
          { provider: 'pleo', orgNumber: '5566778899', returnUrl: 'https://app.accounted.se/api/spend/connections/return', state: 's'.repeat(43) },
          d,
        ),
      body: { provider: 'pleo', orgNumber: '5566778899', returnUrl: 'https://app.accounted.se/api/spend/connections/return', state: 's'.repeat(43) },
    },
    {
      operation: 'complete',
      answer: CONNECTION,
      run: (d) => completeSpendConnect(COMPANY, { state: 's'.repeat(43), result: 'r'.repeat(40) }, d),
      body: { state: 's'.repeat(43), result: 'r'.repeat(40) },
    },
    {
      operation: 'connectKey',
      answer: { ...CONNECTION, mode: 'api_key' },
      run: (d) => connectSpendWithKey(COMPANY, { provider: 'pleo', orgNumber: '5566778899', apiKey: 'pleo_api_key_1234' }, d),
      body: { provider: 'pleo', orgNumber: '5566778899', apiKey: 'pleo_api_key_1234' },
    },
    {
      operation: 'status',
      answer: {
        state: 'active',
        detail: null,
        waitingExpenses: 2,
        lastBatchAt: null,
        masterData: { receivedAt: null, appliedAt: null, state: 'none', issues: [] },
        serverTime: SERVER_TIME,
      },
      run: (d) => fetchSpendStatus(COMPANY, HANDLE, d),
      body: {},
    },
    {
      operation: 'masterData',
      answer: { accepted: true, state: 'pending' },
      run: (d) =>
        sendSpendMasterData(
          COMPANY,
          HANDLE,
          { idempotencyKey: 'conn-1:abc:2026-10-17', accounts: [{ number: '5410', name: 'Förbrukningsinventarier', vatCode: 'SE25' }], vatCodes: [], dimensions: [] },
          d,
        ),
      body: { idempotencyKey: 'conn-1:abc:2026-10-17', accounts: [{ number: '5410', name: 'Förbrukningsinventarier', vatCode: 'SE25' }], vatCodes: [], dimensions: [] },
    },
    {
      operation: 'expenses',
      answer: { expenses: [EXPENSE], more: false, serverTime: SERVER_TIME },
      run: (d) => fetchSpendExpenses(COMPANY, HANDLE, { limit: 50 }, d),
      body: { limit: 50 },
    },
    {
      operation: 'acknowledge',
      answer: { accepted: 1, unknown: [] },
      run: (d) =>
        acknowledgeSpendExpenses(
          COMPANY,
          HANDLE,
          [{ externalId: 'exp-1', outcome: 'received', ledgerRef: 'item-1', ledgerUrl: 'https://app.accounted.se/kortkop?item=item-1' }],
          d,
        ),
      body: { results: [{ externalId: 'exp-1', outcome: 'received', ledgerRef: 'item-1', ledgerUrl: 'https://app.accounted.se/kortkop?item=item-1' }] },
    },
    {
      operation: 'disconnect',
      answer: { disconnected: true },
      run: (d) => disconnectSpendConnection(COMPANY, HANDLE, d),
      body: {},
    },
  ]

  it.each(cases)('$operation: posts to its path with the key, the company and the contract version', async ({ operation, answer, run, body }) => {
    const fetchImpl = respond(200, answer)
    await expect(run(deps(fetchImpl))).resolves.toEqual(answer)
    const call = lastCall(fetchImpl)
    expect(call.url).toBe(`https://connect.example.se/api/connect/spend${SPEND_OPERATIONS[operation].path}`)
    expect(call.init.method).toBe('POST')
    expect(call.init.redirect).toBe('error')
    expect(call.init.cache).toBe('no-store')
    expect(call.init.signal).toBeInstanceOf(AbortSignal)
    expect(call.headers).toMatchObject({
      Authorization: `Bearer ${CONFIG.key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Connector-Company': COMPANY,
      'X-Connect-Contract-Version': CONTRACT_VERSION,
    })
    // The handle travels exactly on the operations the contract marks.
    if (SPEND_OPERATIONS[operation].connection) expect(call.headers['X-Connector-Connection']).toBe(HANDLE)
    else expect(call.headers['X-Connector-Connection']).toBeUndefined()
    expect(call.body).toEqual(body)
  })

  it('sends an empty object when fetching expenses without a limit, and trims a trailing slash off the base URL', async () => {
    const fetchImpl = respond(200, { expenses: [], more: false, serverTime: SERVER_TIME })
    await fetchSpendExpenses(COMPANY, HANDLE, undefined, deps(fetchImpl, { ...CONFIG, baseUrl: 'https://connect.example.se//' }))
    const call = lastCall(fetchImpl)
    expect(call.url).toBe('https://connect.example.se/api/connect/spend/expenses')
    expect(call.body).toEqual({})
  })

  it('carries the service code, the retry hint and Retry-After from an error envelope', async () => {
    const fetchImpl = respond(429, { error: 'wait', code: 'CONNECTOR_SPEND_PROVIDER_RATE_LIMITED', retryable: true }, { 'retry-after': '1200' })
    const err = await fetchSpendExpenses(COMPANY, HANDLE, {}, deps(fetchImpl)).catch((e) => e)
    expect(err).toBeInstanceOf(SpendConnectError)
    expect(err).toMatchObject({ code: 'CONNECTOR_SPEND_PROVIDER_RATE_LIMITED', status: 429, retryable: true, retryAfterSec: 1200 })
  })

  it('lets the envelope decide retryable, and falls back to the status when the envelope does not say', async () => {
    const refused = respond(500, { error: 'no', code: 'CONNECTOR_SPEND_PROVIDER_ERROR', retryable: false })
    await expect(fetchSpendStatus(COMPANY, HANDLE, deps(refused))).rejects.toMatchObject({ code: 'CONNECTOR_SPEND_PROVIDER_ERROR', retryable: false })

    const mismatch = respond(409, { error: 'other company', code: 'CONNECTOR_SPEND_COMPANY_MISMATCH' })
    await expect(completeSpendConnect(COMPANY, { state: 's'.repeat(43), result: 'r'.repeat(40) }, deps(mismatch))).rejects.toMatchObject({
      code: 'CONNECTOR_SPEND_COMPANY_MISMATCH',
      status: 409,
      retryable: false,
      retryAfterSec: null,
    })

    const busy = respond(429, { error: 'slow down', code: 'CONNECTOR_RATE_LIMITED' }, { 'retry-after': '1.5' })
    await expect(listSpendProviders(COMPANY, deps(busy))).rejects.toMatchObject({ code: 'CONNECTOR_RATE_LIMITED', retryable: true, retryAfterSec: 2 })

    // An HTTP date counts too: the wait until then, in whole seconds.
    const until = new Date(Date.now() + 600_000).toUTCString()
    const dated = respond(429, { error: 'slow down', code: 'CONNECTOR_RATE_LIMITED' }, { 'retry-after': until })
    const err = (await listSpendProviders(COMPANY, deps(dated)).then(
      () => null,
      (e: unknown) => e,
    )) as { retryAfterSec: number | null } | null
    expect(err?.retryAfterSec).toBeGreaterThanOrEqual(598)
    expect(err?.retryAfterSec).toBeLessThanOrEqual(600)
  })

  it('answers HTTP_<status> for a body that is not an envelope: retryable on 5xx, not on 4xx', async () => {
    await expect(disconnectSpendConnection(COMPANY, HANDLE, deps(respond(503, '<html>')))).rejects.toMatchObject({ code: 'HTTP_503', status: 503, retryable: true })
    await expect(disconnectSpendConnection(COMPANY, HANDLE, deps(respond(404, '')))).rejects.toMatchObject({ code: 'HTTP_404', status: 404, retryable: false })
  })

  it('reads a Retry-After date as the wait until then, a date already past as no wait, and ignores one it cannot read', async () => {
    const past = respond(503, { error: 'x', code: 'CONNECTOR_SPEND_PROVIDER_ERROR', retryable: true }, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })
    await expect(fetchSpendStatus(COMPANY, HANDLE, deps(past))).rejects.toMatchObject({ retryAfterSec: 0 })
    const unreadable = respond(503, { error: 'x', code: 'CONNECTOR_SPEND_PROVIDER_ERROR', retryable: true }, { 'retry-after': 'soon' })
    await expect(fetchSpendStatus(COMPANY, HANDLE, deps(unreadable))).rejects.toMatchObject({ retryAfterSec: null })
  })

  it('refuses an answer that breaks the contract instead of using it', async () => {
    const badExpense = respond(200, { expenses: [{ ...EXPENSE, currency: 'sek' }], more: false, serverTime: SERVER_TIME })
    await expect(fetchSpendExpenses(COMPANY, HANDLE, {}, deps(badExpense))).rejects.toMatchObject({ code: SPEND_CONNECT_PROTOCOL_ERROR, status: 200, retryable: false })

    const notJson = respond(200, 'ok')
    await expect(fetchSpendStatus(COMPANY, HANDLE, deps(notJson))).rejects.toMatchObject({ code: SPEND_CONNECT_PROTOCOL_ERROR })

    // A consent page that is not https never reaches a browser.
    const httpConsent = respond(200, { authorizeUrl: 'http://auth.pleo.io/oauth/authorize', expiresAt: SERVER_TIME })
    await expect(
      authorizeSpend(COMPANY, { provider: 'pleo', orgNumber: '5566778899', returnUrl: 'https://app.accounted.se/r', state: 's'.repeat(43) }, deps(httpConsent)),
    ).rejects.toMatchObject({ code: SPEND_CONNECT_PROTOCOL_ERROR })
  })

  it('reports an unreachable service as retryable, with the cause kept', async () => {
    const cause = new TypeError('fetch failed')
    const fetchImpl = vi.fn(async () => {
      throw cause
    })
    const err = await listSpendProviders(COMPANY, deps(fetchImpl)).catch((e) => e)
    expect(err).toMatchObject({ code: SPEND_CONNECT_UNREACHABLE, retryable: true, status: null })
    expect((err as Error).cause).toBe(cause)
  })

  it('gives up on a quick operation after 20 seconds but waits longer for the expenses read', async () => {
    vi.useFakeTimers()
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const providers = listSpendProviders(COMPANY, deps(hanging)).catch((e) => e)
    const expenses = fetchSpendExpenses(COMPANY, HANDLE, {}, deps(hanging)).catch((e) => e)
    let expensesSettled = false
    void expenses.then(() => {
      expensesSettled = true
    })

    await vi.advanceTimersByTimeAsync(20_000)
    expect(await providers).toMatchObject({ code: SPEND_CONNECT_UNREACHABLE, retryable: true })
    expect(expensesSettled).toBe(false)

    await vi.advanceTimersByTimeAsync(45_000)
    expect(await expenses).toMatchObject({ code: SPEND_CONNECT_UNREACHABLE })
  })

  it('is unavailable without a connector key, and never sends the key to a plain-http or invalid origin', async () => {
    expect(isSpendConnectConfigured({ config: null })).toBe(false)
    expect(isSpendConnectConfigured({ config: CONFIG })).toBe(true)

    const fetchImpl = respond(200, { providers: [], serverTime: SERVER_TIME })
    await expect(listSpendProviders(COMPANY, deps(fetchImpl, null))).rejects.toMatchObject({ code: SPEND_CONNECT_UNCONFIGURED, retryable: false })
    await expect(listSpendProviders(COMPANY, deps(fetchImpl, { ...CONFIG, baseUrl: 'http://connect.example.se' }))).rejects.toMatchObject({
      code: SPEND_CONNECT_UNCONFIGURED,
    })
    await expect(listSpendProviders(COMPANY, deps(fetchImpl, { ...CONFIG, baseUrl: 'not a url' }))).rejects.toMatchObject({
      code: SPEND_CONNECT_UNCONFIGURED,
    })
    expect(fetchImpl).not.toHaveBeenCalled()

    // Plain http is fine on a loopback host (local development).
    await listSpendProviders(COMPANY, deps(fetchImpl, { ...CONFIG, baseUrl: 'http://localhost:3000' }))
    expect(lastCall(fetchImpl).url).toBe('http://localhost:3000/api/connect/spend/providers')
  })

  it('reads the connector key from the environment when no configuration is passed', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
    expect(isSpendConnectConfigured()).toBe(false)

    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_env_key_value_7890')
    vi.stubEnv('GNUBOK_CONNECT_URL', 'https://connect.example.se')
    expect(isSpendConnectConfigured()).toBe(true)
    const fetchImpl = respond(200, { providers: [], serverTime: SERVER_TIME })
    await listSpendProviders(COMPANY, { fetch: fetchImpl as unknown as typeof fetch })
    const call = lastCall(fetchImpl)
    expect(call.url).toBe('https://connect.example.se/api/connect/spend/providers')
    expect(call.headers.Authorization).toBe('Bearer gnubok_ck_env_key_value_7890')
  })

  it('names the codes after which only a person can help', () => {
    for (const code of [
      SPEND_CONNECT_UNCONFIGURED,
      'CONNECTOR_SPEND_RECONNECT_REQUIRED',
      'CONNECTOR_SPEND_PROVIDER_ACCESS_DENIED',
      'CONNECTOR_CONNECTION_NOT_OWNED',
      'CONNECTOR_SCOPE_MISSING',
      'CONNECTOR_KEY_INVALID',
      'CONNECTOR_KEY_MISSING',
      'CONNECTOR_KEY_SUSPENDED',
    ]) {
      expect(SPEND_ACTION_REQUIRED_CODES.has(code)).toBe(true)
    }
    for (const code of [SPEND_CONNECT_UNREACHABLE, SPEND_CONNECT_PROTOCOL_ERROR, 'CONNECTOR_SPEND_PROVIDER_RATE_LIMITED', 'CONNECTOR_SPEND_PROVIDER_ERROR', 'HTTP_503']) {
      expect(SPEND_ACTION_REQUIRED_CODES.has(code)).toBe(false)
    }
  })
})
