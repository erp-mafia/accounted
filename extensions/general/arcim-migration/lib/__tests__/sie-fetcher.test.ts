import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  providerSupportsSie,
  fetchProviderSieFiles,
  getAllowedFiscalYears,
} from '../sie-fetcher'

// The allowed window is rolling (current year and the two before it): derive
// fixture years from the clock so these tests never go stale at new year.
const CY = new Date().getFullYear()

/**
 * Routes mocked fetch responses by URL substring. The fetcher goes through
 * the real provider clients (rate limiter in in-memory mode, retry on), so
 * these tests exercise the full request path including auth headers and the
 * encoding-detection decode of binary SIE payloads.
 */
function routeFetch(
  fetchSpy: ReturnType<typeof vi.spyOn>,
  routes: { match: string; respond: () => Response }[],
) {
  fetchSpy.mockImplementation(((input: RequestInfo | URL) => {
    const url = String(input)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) {
      return Promise.resolve(new Response(`no mock for ${url}`, { status: 404 }))
    }
    return Promise.resolve(route.respond())
  }) as typeof fetch)
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Build a CP437-encoded SIE snippet containing "Företagskonto" (ö = 0x94). */
function cp437SieBytes(label: string): Uint8Array {
  const prefix = `#FLAGGA 0\n#KONTO 1930 "F`
  const suffix = `retagskonto ${label}"\n`
  const bytes: number[] = []
  for (const c of prefix) bytes.push(c.charCodeAt(0))
  bytes.push(0x94) // 'ö' in CP437
  for (const c of suffix) bytes.push(c.charCodeAt(0))
  return new Uint8Array(bytes)
}

function octetResponse(bytes: Uint8Array): Response {
  return new Response(bytes.buffer as ArrayBuffer, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
}

describe('getAllowedFiscalYears', () => {
  it('is a rolling three-year window ending at the current year', () => {
    const years = getAllowedFiscalYears(new Date('2031-06-15'))
    expect([...years].sort((a, b) => a - b)).toEqual([2029, 2030, 2031])
  })

  it('defaults to the real current year', () => {
    const years = getAllowedFiscalYears()
    expect(years.has(CY)).toBe(true)
    expect(years.has(CY - 2)).toBe(true)
    expect(years.has(CY - 3)).toBe(false)
  })
})

describe('providerSupportsSie', () => {
  it('is true for providers with SIE-over-API, false otherwise', () => {
    expect(providerSupportsSie('fortnox')).toBe(true)
    expect(providerSupportsSie('briox')).toBe(true)
    expect(providerSupportsSie('bjornlunden')).toBe(true)
    expect(providerSupportsSie('visma')).toBe(false)
    expect(providerSupportsSie('bokio')).toBe(false)
  })
})

describe('fetchProviderSieFiles', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('rejects providers without SIE support', async () => {
    await expect(fetchProviderSieFiles('visma', 't', undefined)).rejects.toThrow(
      /does not support SIE over API/,
    )
  })

  describe('briox', () => {
    const yearRoutes = {
      match: '/financialyear',
      respond: () =>
        jsonResponse({
          data: {
            financialyears: [
              { id: '8', fromdate: `${CY - 3}-01-01`, todate: `${CY - 3}-12-31` },
              { id: '9', fromdate: `${CY - 2}-01-01`, todate: `${CY - 2}-12-31` },
              { id: '10', fromdate: `${CY - 1}-01-01`, todate: `${CY - 1}-12-31` },
            ],
          },
        }),
    }

    it('fetches one decoded SIE file per allowed fiscal year', async () => {
      routeFetch(fetchSpy, [
        yearRoutes,
        { match: '/sie/9/4', respond: () => octetResponse(cp437SieBytes(String(CY - 2))) },
        { match: '/sie/10/4', respond: () => octetResponse(cp437SieBytes(String(CY - 1))) },
      ])

      const result = await fetchProviderSieFiles('briox', 'token', undefined)

      // CY-3 is outside the allowed window and must not be fetched
      expect(getAllowedFiscalYears().has(CY - 3)).toBe(false)
      expect(result.availableYears).toEqual([CY - 2, CY - 1])
      expect(result.files.map((f) => f.fiscalYear)).toEqual([CY - 2, CY - 1])
      expect(result.failedYears).toEqual([])
      // CP437 bytes decoded into proper Swedish characters
      expect(result.files[0].rawContent).toContain(`Företagskonto ${CY - 2}`)
      expect(result.files[1].rawContent).toContain(`Företagskonto ${CY - 1}`)
      expect(fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]))).not.toContainEqual(
        expect.stringContaining('/sie/8/4'),
      )
    })

    it('latestOnly fetches just the most recent year but reports all years', async () => {
      routeFetch(fetchSpy, [
        yearRoutes,
        { match: '/sie/10/4', respond: () => octetResponse(cp437SieBytes(String(CY - 1))) },
      ])

      const result = await fetchProviderSieFiles('briox', 'token', undefined, { latestOnly: true })

      expect(result.files).toHaveLength(1)
      expect(result.files[0].fiscalYear).toBe(CY - 1)
      expect(result.availableYears).toEqual([CY - 2, CY - 1])
      const sieCalls = fetchSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/sie/'))
      expect(sieCalls).toHaveLength(1)
    })

    it('reports a year whose export fails in failedYears and keeps the rest', async () => {
      routeFetch(fetchSpy, [
        yearRoutes,
        // 404 is non-retryable, so the bad year fails fast
        { match: '/sie/9/4', respond: () => new Response('gone', { status: 404 }) },
        { match: '/sie/10/4', respond: () => octetResponse(cp437SieBytes(String(CY - 1))) },
      ])

      const result = await fetchProviderSieFiles('briox', 'token', undefined)

      expect(result.files.map((f) => f.fiscalYear)).toEqual([CY - 1])
      expect(result.availableYears).toEqual([CY - 2, CY - 1])
      // The failed year must NOT be dropped silently: importing only the
      // surviving years would break IB/UB continuity unnoticed.
      expect(result.failedYears).toEqual([
        { year: CY - 2, error: expect.stringContaining('404') },
      ])
    })
  })

  describe('fortnox', () => {
    const yearRoutes = {
      match: '/financialyears',
      respond: () =>
        jsonResponse({
          FinancialYears: [
            { Id: 5, FromDate: `${CY - 2}-01-01`, ToDate: `${CY - 2}-12-31` },
            { Id: 6, FromDate: `${CY - 1}-01-01`, ToDate: `${CY - 1}-12-31` },
          ],
        }),
    }

    it('fetches SIE via /sie/4?financialyear={id} and decodes UTF-8 bodies', async () => {
      routeFetch(fetchSpy, [
        yearRoutes,
        {
          match: '/sie/4?financialyear=',
          respond: () => new Response('#FLAGGA 0\n#KONTO 1930 "Företagskonto"\n', { status: 200 }),
        },
      ])

      const result = await fetchProviderSieFiles('fortnox', 'token', undefined)

      expect(result.availableYears).toEqual([CY - 2, CY - 1])
      expect(result.files).toHaveLength(2)
      expect(result.failedYears).toEqual([])
      expect(result.files[0].rawContent).toContain('#KONTO 1930 "Företagskonto"')
      const sieUrls = fetchSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((u: string) => u.includes('/sie/4'))
      expect(sieUrls[0]).toContain('financialyear=5')
      expect(sieUrls[1]).toContain('financialyear=6')
    })

    it('decodes CP437 bytes from the Fortnox SIE endpoint (no blind UTF-8 text())', async () => {
      // Some Fortnox endpoint variants serve the SIE body in CP437 (the SIE
      // spec encoding). A blind response.text() would turn å/ä/ö into U+FFFD
      // irrecoverably: the byte-level path must detect-decode like Briox/BL.
      routeFetch(fetchSpy, [
        yearRoutes,
        {
          match: '/sie/4?financialyear=',
          respond: () => octetResponse(cp437SieBytes(String(CY - 1))),
        },
      ])

      const result = await fetchProviderSieFiles('fortnox', 'token', undefined)

      expect(result.files).toHaveLength(2)
      expect(result.files[1].rawContent).toContain(`Företagskonto ${CY - 1}`)
      expect(result.files[1].rawContent).not.toContain('�')
    })
  })

  describe('bjornlunden', () => {
    it('requires the company User-Key (providerCompanyId)', async () => {
      await expect(fetchProviderSieFiles('bjornlunden', 't', undefined)).rejects.toThrow(/User-Key/)
    })

    it('fetches date-ranged exports with the User-Key header', async () => {
      routeFetch(fetchSpy, [
        {
          match: `/sie/export/${CY - 1}-01-01/${CY - 1}-12-31`,
          respond: () => octetResponse(cp437SieBytes(String(CY - 1))),
        },
        {
          match: '/financialyear',
          respond: () =>
            jsonResponse([
              {
                entityId: 1,
                id: `${CY - 1}01`,
                fromDate: `${CY - 1}-01-01`,
                toDate: `${CY - 1}-12-31`,
                open: true,
              },
            ]),
        },
      ])

      const result = await fetchProviderSieFiles('bjornlunden', 'token', 'user-key-guid')

      expect(result.files).toHaveLength(1)
      expect(result.files[0].fiscalYear).toBe(CY - 1)
      expect(result.files[0].rawContent).toContain(`Företagskonto ${CY - 1}`)

      const exportCall = fetchSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes('/sie/export/'))
      expect(exportCall).toBeDefined()
      expect((exportCall![1] as RequestInit).headers).toMatchObject({
        'User-Key': 'user-key-guid',
        Authorization: 'Bearer token',
      })
    })

    it('also decodes the swagger-declared base64 body shape', async () => {
      // BL's swagger declares the export as a base64 string; the live API
      // sends raw bytes. Guard the contingency path: a JSON-quoted base64
      // payload of CP437 SIE bytes must decode to the same content.
      const sieBytes = cp437SieBytes(String(CY - 1))
      const base64 = Buffer.from(sieBytes).toString('base64')
      routeFetch(fetchSpy, [
        {
          match: `/sie/export/${CY - 1}-01-01/${CY - 1}-12-31`,
          respond: () =>
            new Response(JSON.stringify(base64), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        },
        {
          match: '/financialyear',
          respond: () =>
            jsonResponse([
              {
                entityId: 1,
                id: `${CY - 1}01`,
                fromDate: `${CY - 1}-01-01`,
                toDate: `${CY - 1}-12-31`,
                open: true,
              },
            ]),
        },
      ])

      const result = await fetchProviderSieFiles('bjornlunden', 'token', 'user-key-guid')

      expect(result.files).toHaveLength(1)
      expect(result.files[0].rawContent).toContain(`Företagskonto ${CY - 1}`)
    })
  })
})
