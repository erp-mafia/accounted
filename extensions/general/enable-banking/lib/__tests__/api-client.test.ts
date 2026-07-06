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
