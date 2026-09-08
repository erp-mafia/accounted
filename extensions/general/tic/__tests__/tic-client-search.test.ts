import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchCompaniesByName, __resetTicCacheForTest } from '../lib/tic-client'

const PROXY_URL = 'https://proxy.example.com/api/tic/proxy'

function hit(registrationNumber: string) {
  return {
    document: {
      companyId: 1,
      registrationNumber,
      names: [{ nameOrIdentifier: 'Testbrand AB', companyNamingType: 'name' }],
      legalEntityType: 'AB',
      registrationDate: 0,
    },
  }
}

describe('searchCompaniesByName', () => {
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

  it('queries the nested name field with an encoded, trimmed query and a page cap', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ found: 1, hits: [hit('5560360793')] }), { status: 200 }),
    )

    const docs = await searchCompaniesByName('  Testbrand Bygg & Co  ', 5)

    const endpoint = '/search-public/companies?q=Testbrand%20Bygg%20%26%20Co&query_by=names.nameOrIdentifier&per_page=5'
    expect(mockFetch).toHaveBeenCalledWith(
      `${PROXY_URL}?endpoint=${encodeURIComponent(endpoint)}`,
      expect.anything(),
    )
    expect(docs).toHaveLength(1)
    expect(docs[0].registrationNumber).toBe('5560360793')
  })

  it('returns an empty array without calling upstream for a blank query', async () => {
    const docs = await searchCompaniesByName('   ')
    expect(docs).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns an empty array when the index has no hits', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ found: 0, hits: [] }), { status: 200 }),
    )
    expect(await searchCompaniesByName('Nothing')).toEqual([])
  })

  it('returns an empty array on a 404 from the proxy', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }))
    expect(await searchCompaniesByName('Nothing')).toEqual([])
  })

  it('drops documents without a registration number and caps at the limit', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          found: 4,
          hits: [
            hit('1111111111'),
            { document: { ...hit('').document, registrationNumber: '' } },
            hit('2222222222'),
            hit('3333333333'),
          ],
        }),
        { status: 200 },
      ),
    )
    const docs = await searchCompaniesByName('Testbrand', 2)
    expect(docs.map((d) => d.registrationNumber)).toEqual(['1111111111', '2222222222'])
  })

  it('serves a repeated query from the process cache (one upstream call)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ found: 1, hits: [hit('5560360793')] }), { status: 200 }),
    )
    await searchCompaniesByName('Testbrand')
    await searchCompaniesByName('Testbrand')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
