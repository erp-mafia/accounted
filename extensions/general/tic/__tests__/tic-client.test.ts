import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ticApiFetch,
  searchCompanyByOrgNumber,
  getBankAccounts,
  getIndustryCodes,
  getFiscalYears,
  getPayrolls,
  getSignatory,
  getRepresentatives,
  getCompanyStatus,
  __resetTicCacheForTest,
} from '../lib/tic-client'
import { TICAPIError } from '../lib/tic-types'

const PROXY_URL = 'https://proxy.example.com/api/tic/proxy'

describe('tic-client', () => {
  beforeEach(() => {
    __resetTicCacheForTest()
    vi.stubGlobal('fetch', vi.fn())
    vi.stubEnv('TIC_API_PROXY_URL', PROXY_URL)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  describe('ticApiFetch', () => {
    it('constructs correct proxy URL with encoded endpoint', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: 'test' }), { status: 200 }))

      await ticApiFetch('/search-public/companies?q=5560360793&query_by=registrationNumber')

      expect(mockFetch).toHaveBeenCalledWith(
        `${PROXY_URL}?endpoint=${encodeURIComponent('/search-public/companies?q=5560360793&query_by=registrationNumber')}`,
        expect.objectContaining({
          headers: { Accept: 'application/json' },
        })
      )
    })

    it('returns null on 404', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Not found', { status: 404 }))

      const result = await ticApiFetch('/test')
      expect(result).toBeNull()
    })

    it('throws TICAPIError on 429', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Too many requests', { status: 429 }))

      await expect(ticApiFetch('/test')).rejects.toThrow(TICAPIError)
      await expect(ticApiFetch('/test')).rejects.toMatchObject({
        statusCode: 429,
        code: 'RATE_LIMIT_EXCEEDED',
      })
    })

    it('throws TICAPIError on 500', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })
      )

      await expect(ticApiFetch('/test')).rejects.toThrow(TICAPIError)
    })

    it('throws NOT_CONFIGURED when TIC_API_PROXY_URL is missing', async () => {
      vi.stubEnv('TIC_API_PROXY_URL', '')

      await expect(ticApiFetch('/test')).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
      })
    })

    it('wraps fetch errors in TICAPIError', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network failure'))

      await expect(ticApiFetch('/test')).rejects.toThrow(TICAPIError)
      await expect(ticApiFetch('/test')).rejects.toThrow(/network failure/)
    })
  })

  describe('searchCompanyByOrgNumber', () => {
    it('returns company document on match', async () => {
      const doc = {
        companyId: 123,
        registrationNumber: '5560360793',
        names: [{ nameOrIdentifier: 'Test AB', companyNamingType: 'name' }],
        legalEntityType: 'AB',
        registrationDate: 0,
        isCeased: false,
      }
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ found: 1, hits: [{ document: doc }], facet_counts: [] }))
      )

      const result = await searchCompanyByOrgNumber('556036-0793')
      expect(result).toEqual(doc)
    })

    it('hits the v2 /search-public/companies path', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ found: 0, hits: [] })))

      await searchCompanyByOrgNumber('556036-0793')

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(encodeURIComponent('/search-public/companies'))
    })

    it('strips dashes and spaces from org number', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ found: 0, hits: [] })))

      await searchCompanyByOrgNumber('556036-0793')

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain('q%3D5560360793')
    })

    // Enskild firma: Lens only resolves the 12-digit (century-prefixed) form,
    // so a 10-digit personnummer must be expanded before the query. Björn's
    // 860224-5618 → born 1986 → prefix 19.
    it('expands a 10-digit personnummer to the 12-digit form before querying', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ found: 0, hits: [] })))

      await searchCompanyByOrgNumber('860224-5618')

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain('q%3D198602245618')
    })

    // An organisationsnummer (3rd digit >= 2) must NOT be century-prefixed:
    // Lens resolves an AB from its bare 10-digit number.
    it('does not expand an organisationsnummer', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ found: 0, hits: [] })))

      await searchCompanyByOrgNumber('5595719864')

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain('q%3D5595719864')
    })

    it('returns null when no hits', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ found: 0, hits: [], facet_counts: [] }))
      )

      const result = await searchCompanyByOrgNumber('000000-0000')
      expect(result).toBeNull()
    })

    // TIC v2 is a Typesense fuzzy search: an unindexed number (e.g. an
    // enskild firma's personnummer that Bolagsverket never registered as a
    // company) comes back as the closest lookalike: a different, unrelated
    // entity. We must reject it rather than return a stranger's company.
    it('rejects a fuzzy near-miss whose registrationNumber differs from the query', async () => {
      const lookalike = {
        companyId: 3610062,
        registrationNumber: '8024245618', // digit-shuffle of the requested number
        names: [{ nameOrIdentifier: 'A FOUNDATION', companyNamingType: 'name' }],
        legalEntityType: 'Annan stiftelse',
        registrationDate: 0,
        isCeased: false,
      }
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ found: 1, hits: [{ document: lookalike }], facet_counts: [] }))
      )

      const result = await searchCompanyByOrgNumber('8602245618')
      expect(result).toBeNull()
    })

    // Lens stores an enskild firma under a 16-digit registration number that
    // embeds the 10-digit personnummer. Containment must be accepted, or every
    // correctly-resolved sole trader would be wrongly rejected.
    it('accepts a 16-digit enskild-firma number that embeds the requested personnummer', async () => {
      const soleTrader = {
        companyId: 6704455,
        registrationNumber: '2002011732750001', // contains 0201173275
        names: [{ nameOrIdentifier: 'Sole Trader', companyNamingType: 'name' }],
        legalEntityType: 'Enskild näringsidkare',
        registrationDate: 0,
        isCeased: false,
      }
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ found: 1, hits: [{ document: soleTrader }], facet_counts: [] }))
      )

      const result = await searchCompanyByOrgNumber('0201173275')
      expect(result).toEqual(soleTrader)
    })

    // A real match may not always rank first; accept it wherever it appears.
    it('accepts an exact match even when it is not the top-ranked hit', async () => {
      const nearMiss = {
        companyId: 1,
        registrationNumber: '5560360799',
        names: [{ nameOrIdentifier: 'Near Miss AB', companyNamingType: 'name' }],
        legalEntityType: 'AB',
        registrationDate: 0,
        isCeased: false,
      }
      const exact = {
        companyId: 2,
        registrationNumber: '5560360793',
        names: [{ nameOrIdentifier: 'Exact AB', companyNamingType: 'name' }],
        legalEntityType: 'AB',
        registrationDate: 0,
        isCeased: false,
      }
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ found: 2, hits: [{ document: nearMiss }, { document: exact }], facet_counts: [] })
        )
      )

      const result = await searchCompanyByOrgNumber('556036-0793')
      expect(result).toEqual(exact)
    })
  })

  describe('getBankAccounts', () => {
    it('fetches bankgiro numbers for company ID via /companies/{id}/bank-accounts', async () => {
      const mockFetch = vi.mocked(fetch)
      const accounts = [{ bankgironumber: 1234567, terminated: false, name: 'Test AB' }]
      mockFetch.mockResolvedValue(new Response(JSON.stringify(accounts)))

      const result = await getBankAccounts(123)
      expect(result).toEqual(accounts)
      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(encodeURIComponent('/companies/123/bank-accounts'))
    })
  })

  describe('getIndustryCodes', () => {
    it('fetches industry codes for company ID via /companies/{id}/industries', async () => {
      const mockFetch = vi.mocked(fetch)
      const codes = [
        { companyIndustryCodeType: 'sni2007', industryCode: '62010', description: 'Dataprogrammering' },
      ]
      mockFetch.mockResolvedValue(new Response(JSON.stringify(codes)))

      const result = await getIndustryCodes(123)
      expect(result).toEqual(codes)
      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(encodeURIComponent('/companies/123/industries'))
    })
  })

  describe('getFiscalYears', () => {
    it('hits /companies/{id}/fiscal-years', async () => {
      const mockFetch = vi.mocked(fetch)
      const rows = [{ startMonthDay: '01-01', endMonthDay: '12-31' }]
      mockFetch.mockResolvedValue(new Response(JSON.stringify(rows)))

      const result = await getFiscalYears(123)
      expect(result).toEqual(rows)
      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(encodeURIComponent('/companies/123/fiscal-years'))
    })
  })

  describe('getPayrolls', () => {
    it('hits /companies/{id}/payrolls and returns the wrapper object', async () => {
      const mockFetch = vi.mocked(fetch)
      const payload = { payroll2: [], payrolls: [] }
      mockFetch.mockResolvedValue(new Response(JSON.stringify(payload)))

      const result = await getPayrolls(123)
      expect(result).toEqual(payload)
      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(encodeURIComponent('/companies/123/payrolls'))
    })
  })

  describe('getSignatory', () => {
    it('hits /companies/{id}/signatory (singular per v2)', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue(new Response(JSON.stringify([])))

      await getSignatory(123)
      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(encodeURIComponent('/companies/123/signatory'))
      // Guard against v1's plural path sneaking back in
      expect(calledUrl).not.toContain(encodeURIComponent('/signatories'))
    })
  })

  describe('getRepresentatives', () => {
    it('hits /companies/{id}/representatives', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ representativeInformation: [], representatives: [] }))
      )

      await getRepresentatives(123)
      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(encodeURIComponent('/companies/123/representatives'))
    })
  })

  describe('getCompanyStatus', () => {
    it('hits /companies/{id}/status', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue(new Response(JSON.stringify([])))

      await getCompanyStatus(123)
      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(encodeURIComponent('/companies/123/status'))
    })
  })

  // The in-process cache is the single most impactful change for TIC budget
  // hygiene. Onboarding fires the same orgnr lookup 2-3 times in <2 s
  // (server prefetch + client useEffect + duplicate-check). Without the
  // cache, that's 3x Lens spend per signup; with it, 1x. Test pins the
  // behavior so it can't regress silently.
  describe('in-process cache', () => {
    it('returns cached result for identical endpoint within TTL: fetch fires once', async () => {
      const mockFetch = vi.mocked(fetch)
      const body = { facet_counts: [], found: 1, hits: [{ document: { id: 1 } }] }
      mockFetch.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))

      const first = await ticApiFetch('/search-public/companies?q=5560125790&query_by=registrationNumber')
      const second = await ticApiFetch('/search-public/companies?q=5560125790&query_by=registrationNumber')

      expect(first).toEqual(body)
      expect(second).toEqual(body)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('caches 404 responses so org-number typos do not re-spend a call per keystroke', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue(new Response('Not found', { status: 404 }))

      const first = await ticApiFetch('/search-public/companies?q=000000-0000&query_by=registrationNumber')
      const second = await ticApiFetch('/search-public/companies?q=000000-0000&query_by=registrationNumber')

      expect(first).toBeNull()
      expect(second).toBeNull()
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('does NOT cache 429 rate-limit responses (allows recovery after window resets)', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValueOnce(new Response('Rate limit', { status: 429 }))
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ found: 0, hits: [] }), { status: 200 }))

      await expect(ticApiFetch('/search-public/companies?q=5560125790')).rejects.toMatchObject({
        code: 'RATE_LIMIT_EXCEEDED',
      })
      // Second call should re-fetch (cache must not poison after a 429)
      const second = await ticApiFetch('/search-public/companies?q=5560125790')
      expect(second).toEqual({ found: 0, hits: [] })
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('different endpoints have independent cache entries', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ found: 1 }), { status: 200 }))
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([{ accountNumber: '123' }]), { status: 200 }))

      await ticApiFetch('/search-public/companies?q=A')
      await ticApiFetch('/companies/42/bank-accounts')

      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })
})
