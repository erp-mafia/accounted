import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/tic-client', () => ({
  searchCompanyByOrgNumber: vi.fn(),
  searchCompaniesByName: vi.fn(),
  getBankAccounts: vi.fn(),
  getIndustryCodes: vi.fn(),
  getEmails: vi.fn(),
  getPhones: vi.fn(),
  getFiscalYears: vi.fn(),
}))

import { ticExtension } from '../index'
import { searchCompaniesByName } from '../lib/tic-client'
import { lensRegistrationToOrgNumber, searchCompaniesForLookup } from '../lib/lookup'
import { TICAPIError } from '../lib/tic-types'
import type { TICCompanyDocument } from '../lib/tic-types'

const mockSearch = vi.mocked(searchCompaniesByName)

function makeRequest(q?: string): Request {
  const url = q
    ? `http://localhost/api/extensions/ext/tic/search?q=${encodeURIComponent(q)}`
    : 'http://localhost/api/extensions/ext/tic/search'
  return new Request(url)
}

const route = ticExtension.apiRoutes!.find((r) => r.path === '/search')!
const searchHandler = route.handler

function doc(overrides: Partial<TICCompanyDocument>): TICCompanyDocument {
  return {
    companyId: 1,
    registrationNumber: '5560360793',
    names: [{ nameOrIdentifier: 'Testbrand AB', companyNamingType: 'name' }],
    legalEntityType: 'AB',
    registrationDate: Math.floor(Date.UTC(2020, 0, 1) / 1000),
    mostRecentRegisteredAddress: { streetAddress: 'Storgatan 1', postalCode: '111 22', city: 'Stockholm' },
    isRegisteredForFTax: true,
    isRegisteredForVAT: true,
    isCeased: false,
    activityStatus: 'isActive',
    ...overrides,
  }
}

describe('searchCompaniesForLookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps each document to a hit with a cleaned org number', async () => {
    mockSearch.mockResolvedValue([doc({ registrationNumber: '556036-0793' })])
    const hits = await searchCompaniesForLookup('Testbrand')
    expect(mockSearch).toHaveBeenCalledWith('Testbrand', 5)
    expect(hits).toHaveLength(1)
    expect(hits[0].orgNumber).toBe('5560360793')
    expect(hits[0].result.companyName).toBe('Testbrand AB')
    expect(hits[0].result.legalEntityType).toBe('AB')
    expect(hits[0].result.address?.city).toBe('Stockholm')
  })

  it('sinks ceased companies below active ones without reordering otherwise', async () => {
    mockSearch.mockResolvedValue([
      doc({ companyId: 1, registrationNumber: '5560000019', isCeased: true }),
      doc({ companyId: 2, registrationNumber: '5560000027' }),
      doc({ companyId: 3, registrationNumber: '5560000035', isCeased: true }),
      doc({ companyId: 4, registrationNumber: '5560000043' }),
    ])
    const hits = await searchCompaniesForLookup('Testbrand')
    expect(hits.map((h) => h.orgNumber)).toEqual([
      '5560000027',
      '5560000043',
      '5560000019',
      '5560000035',
    ])
  })

  it("reduces a sole trader's 16-digit Lens number to the 10-digit personnummer form", async () => {
    mockSearch.mockResolvedValue([
      doc({
        registrationNumber: '2002011732750001',
        legalEntityType: 'EF',
        names: [{ nameOrIdentifier: 'Alices Konsult', companyNamingType: 'name' }],
      }),
    ])
    const hits = await searchCompaniesForLookup('Alices Konsult')
    expect(hits).toHaveLength(1)
    expect(hits[0].orgNumber).toBe('0201173275')
    expect(hits[0].result.legalEntityType).toBe('EF')
  })

  it('drops a hit whose registration number cannot become a valid org number', async () => {
    mockSearch.mockResolvedValue([
      doc({ companyId: 1, registrationNumber: '5560000000' }),
      doc({ companyId: 2, registrationNumber: '5560000027' }),
    ])
    const hits = await searchCompaniesForLookup('Testbrand')
    expect(hits.map((h) => h.orgNumber)).toEqual(['5560000027'])
  })
})

describe('lensRegistrationToOrgNumber', () => {
  it('keeps a valid 10-digit organisationsnummer', () => {
    expect(lensRegistrationToOrgNumber('5560360793')).toBe('5560360793')
    expect(lensRegistrationToOrgNumber('556036-0793')).toBe('5560360793')
  })

  it('strips the 16 century prefix from a 12-digit organisationsnummer', () => {
    expect(lensRegistrationToOrgNumber('165560360793')).toBe('5560360793')
  })

  it('strips century and serial from a 16-digit enskild firma number', () => {
    expect(lensRegistrationToOrgNumber('2002011732750001')).toBe('0201173275')
    expect(lensRegistrationToOrgNumber('1980010112310001')).toBe('8001011231')
  })

  it('returns null for a VAT-number shape, a bad check digit, or garbage', () => {
    expect(lensRegistrationToOrgNumber('556036079301')).toBeNull()
    expect(lensRegistrationToOrgNumber('5560360794')).toBeNull()
    expect(lensRegistrationToOrgNumber('')).toBeNull()
    expect(lensRegistrationToOrgNumber('abc')).toBeNull()
  })
})

describe('TIC search route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is registered with skipCompanyContext (user has no company yet)', () => {
    expect(route.method).toBe('GET')
    expect(route.skipCompanyContext).toBe(true)
  })

  it('returns 400 when q is missing', async () => {
    const res = await searchHandler(makeRequest())
    expect(res.status).toBe(400)
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it('returns 400 when q is shorter than the minimum', async () => {
    const res = await searchHandler(makeRequest('ab'))
    expect(res.status).toBe(400)
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it('trims q before measuring it', async () => {
    const res = await searchHandler(makeRequest('  ab  '))
    expect(res.status).toBe(400)
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it("returns the TIC handler's 404 body when nothing matched", async () => {
    mockSearch.mockResolvedValue([])
    const res = await searchHandler(makeRequest('Nothing Like This'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Company not found' })
  })

  it('returns hits in /lookup shape on success', async () => {
    mockSearch.mockResolvedValue([
      doc({ registrationNumber: '5560360793' }),
      doc({ companyId: 2, registrationNumber: '5566778899', names: [{ nameOrIdentifier: 'Testbrand Bygg AB', companyNamingType: 'name' }] }),
    ])
    const res = await searchHandler(makeRequest('Testbrand'))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toHaveLength(2)
    expect(data[0]).toMatchObject({
      orgNumber: '5560360793',
      result: { companyName: 'Testbrand AB', registration: { fTax: true, vat: true } },
    })
    expect(data[1].result.companyName).toBe('Testbrand Bygg AB')
  })

  it('maps a rate limit to 429', async () => {
    mockSearch.mockRejectedValue(new TICAPIError('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED'))
    const res = await searchHandler(makeRequest('Testbrand'))
    expect(res.status).toBe(429)
  })

  it('maps NOT_CONFIGURED to 503', async () => {
    mockSearch.mockRejectedValue(new TICAPIError('missing', undefined, 'NOT_CONFIGURED'))
    const res = await searchHandler(makeRequest('Testbrand'))
    expect(res.status).toBe(503)
  })

  it('maps an upstream 5xx to 502', async () => {
    mockSearch.mockRejectedValue(new TICAPIError('boom', 500))
    const res = await searchHandler(makeRequest('Testbrand'))
    expect(res.status).toBe(502)
  })
})
