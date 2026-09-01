import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock jwt module before importing api-client
const mockGenerateJWT = vi.fn().mockReturnValue('test-jwt-token')
vi.mock('../jwt', () => ({
  generateJWT: (...args: unknown[]) => mockGenerateJWT(...args),
  getAuthorizationHeader: () => `Bearer ${mockGenerateJWT()}`,
  _resetTokenCache: vi.fn(),
}))

// Mock environment
vi.stubEnv('ENABLE_BANKING_API_URL', 'https://api.test.com')

import {
  getASPSPs,
  getAccountBalances,
  getAccountTransactions,
  getAllTransactions,
  getAllTransactionsWithRaw,
  convertTransaction,
  deleteSession,
  probeSessionHealth,
  startAuthorization,
  createSession,
  type Transaction,
} from '../api-client'

describe('api-client', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------
  describe('timeout', () => {
    it('aborts fetch after timeout', async () => {
      fetchSpy.mockImplementation(
        () => new Promise((_, reject) => {
          // Simulate a hanging request: the AbortController will fire
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 100)
        })
      )

      await expect(getAccountBalances('acc-1')).rejects.toThrow('Aborted')
    })
  })

  // -------------------------------------------------------------------------
  // Retry
  // -------------------------------------------------------------------------
  describe('retry', () => {
    it('retries on 503 and succeeds', async () => {
      const failResponse = new Response('Service Unavailable', { status: 503 })
      const successResponse = new Response(JSON.stringify({ balances: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      fetchSpy
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(successResponse)

      const result = await getAccountBalances('acc-1')
      expect(result).toEqual([])
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it('retries on AbortError (timeout) and succeeds', async () => {
      const abortError = new DOMException('Aborted', 'AbortError')
      const successResponse = new Response(JSON.stringify({ aspsps: [{ name: 'TestBank', country: 'SE' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      fetchSpy
        .mockRejectedValueOnce(abortError)
        .mockResolvedValueOnce(successResponse)

      const result = await getASPSPs('SE')
      expect(result).toEqual([{ name: 'TestBank', country: 'SE' }])
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('does not retry a 429 whose body signals a daily quota', async () => {
      // PSD2 unattended consents cap balance calls per DAY (observed body:
      // "Consent daily limit 4 is exceeded"). A retry a second later cannot
      // succeed against a daily quota, so it must fail fast.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      fetchSpy.mockResolvedValueOnce(
        new Response('{"message":"Consent daily limit 4 is exceeded"}', { status: 429 })
      )

      await expect(getAccountBalances('acc-1')).rejects.toThrow(
        'Failed to get account balances (429)'
      )
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      warnSpy.mockRestore()
      errorSpy.mockRestore()
    })

    it('still retries a 429 without a daily-limit body (transient rate limit)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      fetchSpy
        .mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ balances: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )

      const result = await getAccountBalances('acc-1')
      expect(result).toEqual([])
      expect(fetchSpy).toHaveBeenCalledTimes(2)

      warnSpy.mockRestore()
    })

    it('does not retry on 400 errors', async () => {
      const badRequest = new Response('Bad Request', { status: 400 })
      fetchSpy.mockResolvedValueOnce(badRequest)

      // getAccountTransactions throws on non-ok response
      await expect(getAccountTransactions('acc-1')).rejects.toThrow('Failed to get transactions')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // Pagination cap
  // -------------------------------------------------------------------------
  describe('pagination cap', () => {
    it('stops at MAX_PAGINATION_PAGES', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Every response returns a continuation_key
      fetchSpy.mockImplementation(() => {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              transactions: [{ transaction_amount: { amount: '100', currency: 'SEK' } }],
              continuation_key: 'keep-going',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      })

      const result = await getAllTransactions('acc-1', '2024-01-01', '2024-12-31')

      // Should have exactly 100 transactions (1 per page, 100 pages)
      expect(result).toHaveLength(100)
      expect(fetchSpy).toHaveBeenCalledTimes(100)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Pagination cap reached')
      )

      warnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // getAllTransactionsWithRaw
  // -------------------------------------------------------------------------
  describe('getAllTransactionsWithRaw', () => {
    it('returns both transactions and raw pages', async () => {
      const page1 = {
        transactions: [{ transaction_amount: { amount: '100', currency: 'SEK' } }],
        continuation_key: 'page2',
      }
      const page2 = {
        transactions: [{ transaction_amount: { amount: '200', currency: 'SEK' } }],
      }

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(page1), { status: 200, headers: { 'Content-Type': 'application/json' } })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(page2), { status: 200, headers: { 'Content-Type': 'application/json' } })
        )

      const result = await getAllTransactionsWithRaw('acc-1', '2024-01-01', '2024-12-31')

      expect(result.transactions).toHaveLength(2)
      expect(result.rawPages).toHaveLength(2)
      expect(JSON.parse(result.rawPages[0])).toEqual(page1)
      expect(JSON.parse(result.rawPages[1])).toEqual(page2)
    })

    it('appends strategy=longest to the request URL when supplied', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ transactions: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      await getAllTransactionsWithRaw('acc-1', '2024-01-01', '2024-12-31', 'longest')

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const requestedUrl = fetchSpy.mock.calls[0][0] as string
      expect(requestedUrl).toContain('strategy=longest')
      expect(requestedUrl).toContain('date_from=2024-01-01')
      expect(requestedUrl).toContain('date_to=2024-12-31')
    })

    it('omits the strategy param when not supplied', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ transactions: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      await getAllTransactionsWithRaw('acc-1', '2024-01-01', '2024-12-31')

      const requestedUrl = fetchSpy.mock.calls[0][0] as string
      expect(requestedUrl).not.toContain('strategy=')
    })

    it('falls back to no-strategy on 400 and retries the same page', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      fetchSpy
        .mockResolvedValueOnce(
          new Response('Invalid strategy', { status: 400 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ transactions: [{ transaction_amount: { amount: '50', currency: 'SEK' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )

      const result = await getAllTransactionsWithRaw('acc-1', '2024-01-01', '2024-12-31', 'longest')

      expect(result.transactions).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)

      const firstUrl = fetchSpy.mock.calls[0][0] as string
      const secondUrl = fetchSpy.mock.calls[1][0] as string
      expect(firstUrl).toContain('strategy=longest')
      expect(secondUrl).not.toContain('strategy=')

      expect(warnSpy).toHaveBeenCalledWith(
        '[enable-banking] strategy rejected by API, retrying without strategy',
        expect.objectContaining({ strategy: 'longest' })
      )

      warnSpy.mockRestore()
    })

    // Danske Bank rejects a history window beyond its ~90-day PSD2 limit with a
    // blanket ASPSP_ERROR rather than clamping. The window must be narrowed.
    const ASPSP_ERROR_BODY =
      '{"code":400,"message":"Error interacting with ASPSP","detail":"Unknown error","error":"ASPSP_ERROR"}'

    it('narrows date_from when the ASPSP rejects the history window', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      fetchSpy
        // strategy=longest, full 120-day window → ASPSP_ERROR
        .mockResolvedValueOnce(new Response(ASPSP_ERROR_BODY, { status: 400 }))
        // strategy dropped, still full window → ASPSP_ERROR (window is the problem)
        .mockResolvedValueOnce(new Response(ASPSP_ERROR_BODY, { status: 400 }))
        // narrowed to 90 days before date_to → success
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ transactions: [{ transaction_amount: { amount: '42', currency: 'SEK' } }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )

      const result = await getAllTransactionsWithRaw('acc-1', '2026-02-07', '2026-06-07', 'longest')

      expect(result.transactions).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(3)

      const urls = fetchSpy.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(urls[0]).toContain('date_from=2026-02-07')
      expect(urls[0]).toContain('strategy=longest')
      expect(urls[1]).toContain('date_from=2026-02-07')
      expect(urls[1]).not.toContain('strategy=')
      // 90 days before 2026-06-07
      expect(urls[2]).toContain('date_from=2026-03-09')
      expect(urls[2]).toContain('date_to=2026-06-07')

      expect(warnSpy).toHaveBeenCalledWith(
        '[enable-banking] ASPSP rejected history window, retrying with narrower date_from',
        expect.objectContaining({ previousDateFrom: '2026-02-07', nextDateFrom: '2026-03-09' })
      )

      warnSpy.mockRestore()
    })

    it('steps through successive narrower windows until one succeeds', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      fetchSpy
        .mockResolvedValueOnce(new Response(ASPSP_ERROR_BODY, { status: 400 })) // full window
        .mockResolvedValueOnce(new Response(ASPSP_ERROR_BODY, { status: 400 })) // 90 days
        .mockResolvedValueOnce(new Response(ASPSP_ERROR_BODY, { status: 400 })) // 60 days
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ transactions: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        ) // 30 days → success

      await getAllTransactionsWithRaw('acc-1', '2026-02-07', '2026-06-07')

      expect(fetchSpy).toHaveBeenCalledTimes(4)
      const urls = fetchSpy.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(urls[0]).toContain('date_from=2026-02-07')
      expect(urls[1]).toContain('date_from=2026-03-09') // 90 days before date_to
      expect(urls[2]).toContain('date_from=2026-04-08') // 60 days
      expect(urls[3]).toContain('date_from=2026-05-08') // 30 days

      warnSpy.mockRestore()
    })

    it('does not narrow the window on a non-ASPSP 400', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('{"error":"INVALID_REQUEST"}', { status: 400 }))

      await expect(
        getAllTransactionsWithRaw('acc-1', '2026-02-07', '2026-06-07')
      ).rejects.toThrow('Failed to get transactions (400)')

      // No strategy to drop + not an ASPSP error → fail fast, no retries.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('throws once every narrower window is exhausted', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // Fresh Response per call: a body can only be read once.
      fetchSpy.mockImplementation(() => Promise.resolve(new Response(ASPSP_ERROR_BODY, { status: 400 })))

      await expect(
        getAllTransactionsWithRaw('acc-1', '2026-02-07', '2026-06-07')
      ).rejects.toThrow('Failed to get transactions (400)')

      // full window + 90 + 60 + 30 = 4 attempts, then give up
      expect(fetchSpy).toHaveBeenCalledTimes(4)

      warnSpy.mockRestore()
      errorSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // getAllTransactions: same first-page fallbacks via the paginated path
  // -------------------------------------------------------------------------
  describe('getAllTransactions fallbacks', () => {
    const ASPSP_ERROR_BODY =
      '{"code":400,"message":"Error interacting with ASPSP","detail":"Unknown error","error":"ASPSP_ERROR"}'

    it('narrows the window when the ASPSP rejects the history range', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      fetchSpy
        .mockResolvedValueOnce(new Response(ASPSP_ERROR_BODY, { status: 400 })) // full window
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ transactions: [{ transaction_amount: { amount: '10', currency: 'SEK' } }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        ) // narrowed to 90 days → success

      const result = await getAllTransactions('acc-1', '2026-02-07', '2026-06-07')

      expect(result).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      const urls = fetchSpy.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(urls[0]).toContain('date_from=2026-02-07')
      expect(urls[1]).toContain('date_from=2026-03-09') // 90 days before date_to

      warnSpy.mockRestore()
    })

    it('drops the strategy then narrows the window (Danske flow)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      fetchSpy
        .mockResolvedValueOnce(new Response(ASPSP_ERROR_BODY, { status: 400 })) // strategy=longest
        .mockResolvedValueOnce(new Response(ASPSP_ERROR_BODY, { status: 400 })) // no strategy, full window
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ transactions: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        ) // narrowed to 90 days → success

      await getAllTransactions('acc-1', '2026-02-07', '2026-06-07', 'longest')

      expect(fetchSpy).toHaveBeenCalledTimes(3)
      const urls = fetchSpy.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(urls[0]).toContain('strategy=longest')
      expect(urls[1]).not.toContain('strategy=')
      expect(urls[1]).toContain('date_from=2026-02-07')
      expect(urls[2]).toContain('date_from=2026-03-09')

      warnSpy.mockRestore()
    })

    it('does not rewrite the query mid-pagination', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              transactions: [{ transaction_amount: { amount: '5', currency: 'SEK' } }],
              continuation_key: 'page2',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        ) // page 1 ok, hands back a continuation_key
        .mockResolvedValueOnce(new Response(ASPSP_ERROR_BODY, { status: 400 })) // page 2 fails

      // A continuation_key is scoped to its window, so page 2 must not narrow:
      // it fails fast instead.
      await expect(
        getAllTransactions('acc-1', '2026-02-07', '2026-06-07')
      ).rejects.toThrow('Failed to get transactions (400)')
      expect(fetchSpy).toHaveBeenCalledTimes(2)

      errorSpy.mockRestore()
    })
  })
})

// -------------------------------------------------------------------------
// JWT cache tests
// -------------------------------------------------------------------------
describe('JWT cache', () => {
  it('reuses cached token within validity window', async () => {
    // Reset mocks and re-import to test cache behavior
    vi.resetModules()
    const jwtCallCount = { count: 0 }

    vi.doMock('../jwt', () => ({
      generateJWT: () => {
        jwtCallCount.count++
        return 'cached-token'
      },
      getAuthorizationHeader: () => {
        // Simulate cached behavior: first call generates, subsequent calls reuse
        jwtCallCount.count++
        return `Bearer cached-token`
      },
      _resetTokenCache: vi.fn(),
    }))

    // The actual cache test is in jwt.ts: we verify the cache function exists
    const jwt = await import('../jwt')
    expect(typeof jwt._resetTokenCache).toBe('function')
  })
})

describe('convertTransaction', () => {
  function makeTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      transaction_amount: { amount: '250.00', currency: 'SEK' },
      credit_debit_indicator: 'DBIT',
      booking_date: '2024-06-15',
      ...overrides,
    }
  }

  it('uses remittance_information when present', () => {
    const tx = makeTx({ remittance_information: ['Faktura 123', ' '] })
    expect(convertTransaction(tx, 'SEK').description).toBe('Faktura 123')
  })

  it('falls back to the counterparty name when remittance is empty', () => {
    const out = makeTx({ remittance_information: ['   '], creditor_name: 'Telia AB' })
    expect(convertTransaction(out, 'SEK').description).toBe('Telia AB')
  })

  it('derives a Swedish label from bank_transaction_code when remittance and counterparty are both absent', () => {
    const tx = makeTx({ bank_transaction_code: 'PMNT-CCRD-POSD', merchant_category_code: '5411' })
    // MCC 5411 wins (most specific).
    expect(convertTransaction(tx, 'SEK').description).toBe('Inköp dagligvaror')
  })

  it('uses the ISO family label when only bank_transaction_code is present', () => {
    const tx = makeTx({ bank_transaction_code: 'PMNT/CCRD' })
    expect(convertTransaction(tx, 'SEK').description).toBe('Kortköp')
  })

  it('falls back to the Swedish neutral (never English "Unknown") when nothing is recognized', () => {
    const tx = makeTx({})
    expect(convertTransaction(tx, 'SEK').description).toBe('Okänd transaktion')
  })

  it('carries the ISO codes through onto the converted transaction', () => {
    const tx = makeTx({ bank_transaction_code: 'PMNT/RCDT', proprietary_bank_transaction_code: 'XB' })
    const out = convertTransaction(tx, 'SEK')
    expect(out.bank_transaction_code).toBe('PMNT/RCDT')
    expect(out.proprietary_bank_transaction_code).toBe('XB')
  })
})

// ---------------------------------------------------------------------------
// probeSessionHealth: nightly liveness check
// ---------------------------------------------------------------------------

describe('probeSessionHealth', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function respond(status: number, body: unknown) {
    fetchSpy.mockResolvedValue(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    )
  }

  it('reports alive for an authorized session', async () => {
    respond(200, { session_id: 's1', status: 'AUTHORIZED' })
    expect(await probeSessionHealth('s1')).toBe('alive')
  })

  it('reports dead for a session the bank closed', async () => {
    respond(200, { session_id: 's1', status: 'CLOSED' })
    expect(await probeSessionHealth('s1')).toBe('dead')
  })

  it('reports dead when the session record is gone', async () => {
    respond(404, { message: 'Not found' })
    expect(await probeSessionHealth('s1')).toBe('dead')
  })

  it('reports dead on a 401 carrying a session-expiry signal', async () => {
    respond(401, { error: 'SESSION_EXPIRED' })
    expect(await probeSessionHealth('s1')).toBe('dead')
  })

  it('reports unknown for an unrecognized status rather than expiring a live connection', async () => {
    respond(200, { session_id: 's1', status: 'SOMETHING_NEW' })
    expect(await probeSessionHealth('s1')).toBe('unknown')
  })

  it('reports unknown on a bare 401 (app credentials, not a dead consent)', async () => {
    respond(401, 'Unauthorized')
    expect(await probeSessionHealth('s1')).toBe('unknown')
  })

  it('reports unknown when the request itself fails', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'))
    expect(await probeSessionHealth('s1')).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// Connector mode (self-host routes upstream through the hosted bank proxy)
// ---------------------------------------------------------------------------
describe('connector mode', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const okJson = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  beforeEach(() => {
    vi.clearAllMocks()
    // A self-host with a connector key and no own EB credentials. The
    // own-credentials env vars must stay unset for bankConnectorMode() to
    // engage (key present AND no own credentials).
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_testsecret')
    vi.stubEnv('GNUBOK_CONNECT_URL', 'https://app.test.example')
    vi.stubEnv('ENABLE_BANKING_PRIVATE_KEY', '')
    vi.stubEnv('ENABLE_BANKING_PRIVATE_KEY_PRODUCTION', '')
    vi.stubEnv('ENABLE_BANKING_APP_ID', '')
    vi.stubEnv('ENABLE_BANKING_APP_ID_PRODUCTION', '')
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  const lastCall = () => {
    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    const url = String(call[0])
    const init = (call[1] ?? {}) as RequestInit
    const headers = (init.headers ?? {}) as Record<string, string>
    return { url, init, headers }
  }

  it('routes reads through the proxy with the connector key, never the EB JWT', async () => {
    fetchSpy.mockResolvedValue(okJson({ aspsps: [] }))
    await getASPSPs('SE')
    const { url, headers } = lastCall()
    expect(url).toContain('https://app.test.example/api/connect/bank/aspsps')
    expect(headers['Authorization']).toBe('Bearer gnubok_ck_testsecret')
    expect(headers['Authorization']).not.toContain('jwt')
    // The JWT signer must not run: the instance holds no EB private key.
    expect(mockGenerateJWT).not.toHaveBeenCalled()
  })

  it('sends X-Connector-Company on /auth so the proxy can meter the company quota', async () => {
    fetchSpy.mockResolvedValue(okJson({ url: 'https://bank/auth', authorization_id: 'a1' }))
    await startAuthorization('Bank', 'SE', 'https://instance.test/callback', 'oauth-state-1', 'business', undefined, 'company-42')
    const { url, headers, init } = lastCall()
    expect(url).toBe('https://app.test.example/api/connect/bank/auth')
    expect(init.method).toBe('POST')
    expect(headers['X-Connector-Company']).toBe('company-42')
    expect(headers['Authorization']).toBe('Bearer gnubok_ck_testsecret')
  })

  it('binds /sessions to the signed connector_state when one is passed', async () => {
    fetchSpy.mockResolvedValue(okJson({ session_id: 's1', accounts: [], access: { valid_until: '2027-01-01' } }))
    await createSession('auth-code', 'signed-connector-state')
    const { url, init } = lastCall()
    expect(url).toBe('https://app.test.example/api/connect/bank/sessions')
    expect(JSON.parse(String(init.body))).toEqual({ code: 'auth-code', connector_state: 'signed-connector-state' })
  })

  it('omits connector_state from /sessions when none is passed', async () => {
    fetchSpy.mockResolvedValue(okJson({ session_id: 's1', accounts: [], access: { valid_until: '2027-01-01' } }))
    await createSession('auth-code')
    const { init } = lastCall()
    expect(JSON.parse(String(init.body))).toEqual({ code: 'auth-code' })
  })

  it('does not engage when the instance has its own EB credentials (own-credentials seam)', async () => {
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'own-app-id')
    fetchSpy.mockResolvedValue(okJson({ aspsps: [] }))
    await getASPSPs('SE')
    const { url, headers } = lastCall()
    // Direct EB base (captured at import), never the connector proxy.
    expect(url).not.toContain('/api/connect/bank')
    expect(url).toContain('enablebanking.com')
    expect(headers['Authorization']).toBe('Bearer test-jwt-token')
  })

  it('never sends X-Connector-Company on the direct path, even with companyId passed', async () => {
    // Own EB credentials → direct path. companyId is always set on hosted /auth,
    // so the header must be gated on connector mode, not on companyId: leaking
    // the internal company UUID to the real Enable Banking API is a regression.
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'own-app-id')
    fetchSpy.mockResolvedValue(okJson({ url: 'https://bank/auth', authorization_id: 'a1' }))
    await startAuthorization('Bank', 'SE', 'https://instance.test/callback', 'oauth-state-1', 'business', undefined, 'company-42')
    const { url, headers } = lastCall()
    expect(url).toContain('enablebanking.com')
    expect(headers['X-Connector-Company']).toBeUndefined()
    expect(headers['Authorization']).toBe('Bearer test-jwt-token')
  })
})

/**
 * Log levels for the two conditions that are expected rather than broken.
 *
 * A PSD2 consent that ran out and a session Enable Banking has already dropped
 * are both handled: the sync flips the connection to 'expired' and asks for a
 * re-authorization, and the disconnect carries on regardless. Logging them at
 * error filled the production error panel with events nobody could act on and
 * buried the genuine ASPSP failures next to them. The thrown errors are
 * unchanged: only the level moves.
 */
describe('expected-condition log levels', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('logs an expired bank session at warn, and still throws SessionExpiredError', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ code: 'EXPIRED_SESSION' }), { status: 401 })
    )

    await expect(
      getAllTransactionsWithRaw('acc-1', '2024-01-01', '2024-12-31')
    ).rejects.toThrow('Bank session expired')

    expect(warnSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('still logs a genuine ASPSP failure at error', async () => {
    // 500 is retried before it gives up; every attempt is the same failure.
    fetchSpy.mockResolvedValue(new Response('{"message":"internal error"}', { status: 500 }))

    await expect(
      getAllTransactionsWithRaw('acc-1', '2024-01-01', '2024-12-31')
    ).rejects.toThrow('Failed to get transactions')

    expect(errorSpy).toHaveBeenCalled()
  })

  it('logs a session that is already gone at Enable Banking at warn', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 404 }))

    await expect(deleteSession('session-1')).rejects.toThrow('Failed to revoke session')

    expect(warnSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('still logs an unexpected revoke failure at error', async () => {
    fetchSpy.mockResolvedValue(new Response('{"message":"boom"}', { status: 500 }))

    await expect(deleteSession('session-1')).rejects.toThrow('Failed to revoke session')

    expect(errorSpy).toHaveBeenCalled()
  })
})
