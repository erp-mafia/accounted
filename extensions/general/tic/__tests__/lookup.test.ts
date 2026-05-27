import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the tic-client functions. /lookup now only calls
// searchCompanyByOrgNumber — the Phase 2 fetchers stay mocked because the
// /profile handler shares the module, but we don't expect /lookup to invoke
// them.
vi.mock('../lib/tic-client', () => ({
  searchCompanyByOrgNumber: vi.fn(),
  getBankAccounts: vi.fn(),
  getIndustryCodes: vi.fn(),
  getEmails: vi.fn(),
  getPhones: vi.fn(),
  getFiscalYears: vi.fn(),
}))

import { ticExtension } from '../index'
import {
  searchCompanyByOrgNumber,
  getBankAccounts,
  getIndustryCodes,
  getEmails,
  getPhones,
  getFiscalYears,
} from '../lib/tic-client'
import { TICAPIError } from '../lib/tic-types'
import type { TICCompanyDocument } from '../lib/tic-types'

const mockSearch = vi.mocked(searchCompanyByOrgNumber)
const mockBank = vi.mocked(getBankAccounts)
const mockIndustries = vi.mocked(getIndustryCodes)
const mockEmails = vi.mocked(getEmails)
const mockPhones = vi.mocked(getPhones)
const mockFiscalYears = vi.mocked(getFiscalYears)

function makeRequest(orgNumber?: string): Request {
  const url = orgNumber
    ? `http://localhost/api/extensions/ext/tic/lookup?org_number=${encodeURIComponent(orgNumber)}`
    : 'http://localhost/api/extensions/ext/tic/lookup'
  return new Request(url)
}

const lookupHandler = ticExtension.apiRoutes![0].handler

// Search-public document now carries everything /lookup needs at the top
// level — sniCodes, bankAccounts, emailAddresses, phoneNumbers,
// mostRecentFinancialSummary. The previous Phase 2 fan-out duplicated these.
const mockDoc: TICCompanyDocument = {
  companyId: 42,
  registrationNumber: '5560360793',
  names: [
    { nameOrIdentifier: 'Registered Name', companyNamingType: 'registeredName' },
    { nameOrIdentifier: 'Test AB', companyNamingType: 'name' },
  ],
  legalEntityType: 'AB',
  registrationDate: 0,
  mostRecentRegisteredAddress: {
    streetAddress: 'Storgatan 1',
    postalCode: '111 22',
    city: 'Stockholm',
  },
  isRegisteredForFTax: true,
  isRegisteredForVAT: true,
  isCeased: false,
  activityStatus: 'isActive',
  sniCodes: [
    { rank: 1, sni_2007Code: '62010', sni_2007Name: 'Dataprogrammering', sni_2007Section: 'J' },
  ],
  bankAccounts: [{ accountNumber: '1234567', bankAccountType: 'bankgiro' }],
  emailAddresses: [{ emailAddress: 'info@test.se', emailAddressType: 'general' }],
  phoneNumbers: [{ phoneNumberFormatted: '08-1234567', e164PhoneNumber: '+4681234567' }],
  mostRecentFinancialSummary: {
    // 2024-01-01 → 2024-12-31 (Unix seconds, UTC)
    periodStart: Math.floor(Date.UTC(2024, 0, 1) / 1000),
    periodEnd: Math.floor(Date.UTC(2024, 11, 31) / 1000),
  },
}

describe('TIC lookup route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when org_number is missing', async () => {
    const res = await lookupHandler(makeRequest())
    expect(res.status).toBe(400)
  })

  it('returns 404 when company not found', async () => {
    mockSearch.mockResolvedValue(null)

    const res = await lookupHandler(makeRequest('000000-0000'))
    expect(res.status).toBe(404)
  })

  it('returns full lookup result from the search doc alone', async () => {
    mockSearch.mockResolvedValue(mockDoc)

    const res = await lookupHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(200)

    const { data } = await res.json()
    expect(data.companyName).toBe('Test AB')
    expect(data.isCeased).toBe(false)
    expect(data.address).toEqual({
      street: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
    })
    expect(data.registration).toEqual({ fTax: true, vat: true })
    expect(data.bankAccounts).toEqual([
      { type: 'bankgiro', accountNumber: '1234567', bic: null },
    ])
    expect(data.sniCodes).toEqual([{ code: '62010', name: 'Dataprogrammering' }])
    expect(data.email).toBe('info@test.se')
    expect(data.phone).toBe('08-1234567')
    expect(data.fiscalYear).toEqual({ startMonthDay: '01-01', endMonthDay: '12-31' })
  })

  it('does NOT fan out to Phase 2 endpoints', async () => {
    mockSearch.mockResolvedValue(mockDoc)
    await lookupHandler(makeRequest('556036-0793'))
    expect(mockBank).not.toHaveBeenCalled()
    expect(mockIndustries).not.toHaveBeenCalled()
    expect(mockEmails).not.toHaveBeenCalled()
    expect(mockPhones).not.toHaveBeenCalled()
    expect(mockFiscalYears).not.toHaveBeenCalled()
  })

  it('derives fiscal year MM-DD from mostRecentFinancialSummary', async () => {
    mockSearch.mockResolvedValue({
      ...mockDoc,
      mostRecentFinancialSummary: {
        // 2024-07-01 → 2025-06-30 (broken fiscal year)
        periodStart: Math.floor(Date.UTC(2024, 6, 1) / 1000),
        periodEnd: Math.floor(Date.UTC(2025, 5, 30) / 1000),
      },
    })

    const res = await lookupHandler(makeRequest('556036-0793'))
    const { data } = await res.json()
    expect(data.fiscalYear).toEqual({ startMonthDay: '07-01', endMonthDay: '06-30' })
  })

  it('returns fiscalYear null when the company has no closed period yet', async () => {
    mockSearch.mockResolvedValue({ ...mockDoc, mostRecentFinancialSummary: undefined })

    const res = await lookupHandler(makeRequest('556036-0793'))
    const { data } = await res.json()
    expect(data.fiscalYear).toBeNull()
  })

  it('filters non-bankgiro entries from doc.bankAccounts', async () => {
    mockSearch.mockResolvedValue({
      ...mockDoc,
      bankAccounts: [
        { accountNumber: '1234567', bankAccountType: 'bankgiro' },
        { accountNumber: 'SE45 5000', bankAccountType: 'iban' },
      ],
    })

    const res = await lookupHandler(makeRequest('556036-0793'))
    const { data } = await res.json()
    expect(data.bankAccounts).toEqual([
      { type: 'bankgiro', accountNumber: '1234567', bic: null },
    ])
  })

  it('falls back to e164 when phoneNumberFormatted is missing', async () => {
    mockSearch.mockResolvedValue({
      ...mockDoc,
      phoneNumbers: [{ e164PhoneNumber: '+4681234567' }],
    })

    const res = await lookupHandler(makeRequest('556036-0793'))
    const { data } = await res.json()
    expect(data.phone).toBe('+4681234567')
  })

  it('prefers name type over other naming types', async () => {
    mockSearch.mockResolvedValue(mockDoc)

    const res = await lookupHandler(makeRequest('556036-0793'))
    const { data } = await res.json()
    expect(data.companyName).toBe('Test AB')
  })

  it('handles missing optional fields gracefully', async () => {
    mockSearch.mockResolvedValue({
      ...mockDoc,
      sniCodes: undefined,
      bankAccounts: undefined,
      emailAddresses: undefined,
      phoneNumbers: undefined,
    })

    const res = await lookupHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(200)

    const { data } = await res.json()
    expect(data.companyName).toBe('Test AB')
    expect(data.bankAccounts).toEqual([])
    expect(data.sniCodes).toEqual([])
    expect(data.email).toBeNull()
    expect(data.phone).toBeNull()
  })

  it('detects ceased companies via isCeased boolean', async () => {
    mockSearch.mockResolvedValue({ ...mockDoc, isCeased: true, activityStatus: 'isNoLongerActive' })

    const res = await lookupHandler(makeRequest('556036-0793'))
    const { data } = await res.json()
    expect(data.isCeased).toBe(true)
  })

  it('returns 503 when TIC is not configured', async () => {
    mockSearch.mockRejectedValue(
      new TICAPIError('TIC_API_PROXY_URL is not configured', undefined, 'NOT_CONFIGURED')
    )
    const res = await lookupHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(503)
  })

  it('returns 429 when TIC rate-limits us', async () => {
    mockSearch.mockRejectedValue(
      new TICAPIError('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED')
    )
    const res = await lookupHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(429)
  })

  it('returns 504 when TIC times out', async () => {
    mockSearch.mockRejectedValue(new TICAPIError('Request timeout', undefined, 'TIMEOUT'))
    const res = await lookupHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(504)
  })

  it('returns 400 when upstream rejects the org number (4xx)', async () => {
    mockSearch.mockRejectedValue(new TICAPIError('TIC API error: Bad Request', 400))
    const res = await lookupHandler(makeRequest('1234567-1234'))
    expect(res.status).toBe(400)
  })

  it('returns 502 when upstream returns 5xx', async () => {
    mockSearch.mockRejectedValue(new TICAPIError('TIC API error: Bad Gateway', 502))
    const res = await lookupHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(502)
  })

  it('returns 502 when fetch fails (network error)', async () => {
    mockSearch.mockRejectedValue(new TICAPIError('Failed to fetch from TIC: ECONNRESET'))
    const res = await lookupHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(502)
  })

  it('returns 500 for non-TICAPIError unexpected errors', async () => {
    mockSearch.mockRejectedValue(new Error('boom'))
    const res = await lookupHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(500)
  })
})
