import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BjornLundenClient, BjornLundenApiError } from '../client'

/**
 * Mocked-fetch tests for the BL HTTP client. Sandbox-verified behaviors under
 * guard here:
 *   - pagination uses `page` + `rows` (a `pageRequested` request param is
 *     IGNORED by the API: sending it loops on page 1 forever)
 *   - every call carries Authorization Bearer + the per-company User-Key
 *   - 429/5xx retry, 401/403/404 fail fast (a wrong User-Key surfaces as 500)
 */

const TOKEN = 'access-token'
const USER_KEY = '69f15a2d-0000-0000-0000-000000000000'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('BjornLundenClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let client: BjornLundenClient

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    client = new BjornLundenClient()
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  describe('headers', () => {
    it('sends Authorization Bearer and User-Key on get()', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ name: 'Arcim TEST' }))

      await client.get(TOKEN, USER_KEY, '/details')

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, opts] = fetchSpy.mock.calls[0]
      expect(String(url)).toBe('https://apigateway.blinfo.se/bla-api/v1/sp/details')
      expect((opts as RequestInit).headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        'User-Key': USER_KEY,
        Accept: 'application/json',
      })
    })

    it('sends the same auth headers on getBytes()', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array([0x23, 0x46]).buffer as ArrayBuffer, { status: 200 }))

      const buf = await client.getBytes(TOKEN, USER_KEY, '/sie/export/2025-01-01/2025-12-31')

      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x23, 0x46]))
      const [, opts] = fetchSpy.mock.calls[0]
      expect((opts as RequestInit).headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        'User-Key': USER_KEY,
      })
    })
  })

  describe('pagination params', () => {
    it('getPage sends page + rows and NOT pageRequested/rowsRequested', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ pageRequested: 2, totalPages: 5, totalRows: 230, data: [{ id: 1 }] }),
      )

      const result = await client.getPage(TOKEN, USER_KEY, '/customerinvoice/batch', {
        page: 2,
        pageSize: 50,
      })

      const url = new URL(String(fetchSpy.mock.calls[0][0]))
      expect(url.searchParams.get('page')).toBe('2')
      expect(url.searchParams.get('rows')).toBe('50')
      expect(url.searchParams.has('pageRequested')).toBe(false)
      expect(url.searchParams.has('rowsRequested')).toBe(false)

      expect(result.page).toBe(2)
      expect(result.totalPages).toBe(5)
      expect(result.totalCount).toBe(230)
      expect(result.items).toEqual([{ id: 1 }])
    })

    it('getPage tolerates a missing data array', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ pageRequested: 99, totalPages: 5, totalRows: 230 }))

      const result = await client.getPage(TOKEN, USER_KEY, '/customerinvoice/batch', { page: 99 })
      expect(result.items).toEqual([])
    })
  })

  describe('getAll', () => {
    it('accepts a plain array response (e.g. /customer, /financialyear)', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse([{ id: '1000' }, { id: '1001' }]))

      const items = await client.getAll(TOKEN, USER_KEY, '/customer')
      expect(items).toHaveLength(2)
    })

    it('unwraps a paginated envelope when one is returned', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ pageRequested: 1, totalPages: 1, totalRows: 1, data: [{ id: 'x' }] }),
      )

      const items = await client.getAll(TOKEN, USER_KEY, '/whatever')
      expect(items).toEqual([{ id: 'x' }])
    })
  })

  describe('listFinancialYears', () => {
    it('returns the plain /financialyear array', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([
          { entityId: 9, id: '202501', fromDate: '2025-01-01', toDate: '2025-12-31', open: true },
        ]),
      )

      const years = await client.listFinancialYears(TOKEN, USER_KEY)
      expect(years).toHaveLength(1)
      expect(years[0].fromDate).toBe('2025-01-01')
      expect(String(fetchSpy.mock.calls[0][0])).toContain('/financialyear')
    })
  })

  describe('retry semantics', () => {
    it('retries on 429 and succeeds', async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }))

      const result = await client.get<{ ok: boolean }>(TOKEN, USER_KEY, '/details')
      expect(result).toEqual({ ok: true })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    }, 10_000)

    it('does NOT retry on 401', async () => {
      fetchSpy.mockResolvedValue(new Response('unauthorized', { status: 401 }))

      await expect(client.get(TOKEN, USER_KEY, '/details')).rejects.toMatchObject({
        name: 'BjornLundenApiError',
        statusCode: 401,
      })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry on 404', async () => {
      fetchSpy.mockResolvedValue(new Response('not found', { status: 404 }))

      await expect(client.get(TOKEN, USER_KEY, '/nope')).rejects.toBeInstanceOf(BjornLundenApiError)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('exposes status and body on the error for upstream classification', async () => {
      // Fresh Response per attempt: a Response body can only be read once
      fetchSpy.mockImplementation(() =>
        Promise.resolve(new Response('{"status":"INTERNAL_SERVER_ERROR"}', { status: 500 })),
      )

      // 500 IS retried (transient by contract): all attempts exhausted here.
      // A wrong User-Key also answers 500; submit-token validation relies on
      // the BjornLundenApiError shape to classify it.
      await expect(client.get(TOKEN, USER_KEY, '/details')).rejects.toMatchObject({
        statusCode: 500,
        body: '{"status":"INTERNAL_SERVER_ERROR"}',
      })
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    }, 15_000)
  })
})
