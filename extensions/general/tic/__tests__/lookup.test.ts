import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the tic-client functions. /lookup now only calls
// searchCompanyByOrgNumber: the Phase 2 fetchers stay mocked because the
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

// SCB is the fallback for a TIC miss (Bolagsverket does not list ideella
// föreningar). Off by default so every existing case stays a plain miss.
vi.mock('@/lib/parties/scb/config', () => ({
  isScbConfigured: vi.fn(() => false),
  scbConfigFromEnv: vi.fn(() => ({})),
}))
vi.mock('@/lib/parties/scb/client', () => ({
  createScbClient: vi.fn(),
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
import { isScbConfigured } from '@/lib/parties/scb/config'
import { createScbClient } from '@/lib/parties/scb/client'
import { factsFromScbCompany } from '@/lib/parties/scb/map'

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
// level: sniCodes, bankAccounts, emailAddresses, phoneNumbers,
// mostRecentFinancialSummary. The previous Phase 2 fan-out duplicated these.
const mockDoc: TICCompanyDocument = {
  companyId: 42,
  registrationNumber: '5560360793',
  // Real Lens v2 shape: newest-decided first, so a särskilt företagsnamn
  // registered after the firma precedes the legal name.
  names: [
    { nameOrIdentifier: 'Brand Name', companyNamingType: 'particularName' },
    { nameOrIdentifier: 'Test AB', companyNamingType: 'legalName' },
  ],
  legalEntityType: 'AB',
  // 2026-02-02 in Unix seconds (TIC's native unit; the route converts to ms)
  registrationDate: Math.floor(Date.UTC(2026, 1, 2) / 1000),
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
    expect(data.registrationDate).toBe(Date.UTC(2026, 1, 2))
  })

  it('converts registrationDate from Unix seconds to a millisecond epoch', async () => {
    mockSearch.mockResolvedValue(mockDoc)

    const res = await lookupHandler(makeRequest('556036-0793'))
    const { data } = await res.json()
    // Regression: fed raw seconds into `new Date()`, a 2026 registration
    // rendered as 1970-01-21 in onboarding's fiscal-year step.
    expect(new Date(data.registrationDate).toISOString().slice(0, 10)).toBe('2026-02-02')
  })

  it('returns registrationDate null when the doc lacks one', async () => {
    mockSearch.mockResolvedValue({
      ...mockDoc,
      registrationDate: undefined as unknown as number,
    })

    const res = await lookupHandler(makeRequest('556036-0793'))
    const { data } = await res.json()
    expect(data.registrationDate).toBeNull()
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

  it('returns the legal name, not a newer särskilt företagsnamn listed first', async () => {
    mockSearch.mockResolvedValue({
      ...mockDoc,
      names: [
        { nameOrIdentifier: 'Newest Brand', companyNamingType: 'particularName' },
        { nameOrIdentifier: 'Older Brand', companyNamingType: 'particularName' },
        { nameOrIdentifier: 'Test AB', companyNamingType: 'legalName' },
      ],
    })

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

describe('TIC lookup route: SCB fallback after a miss', () => {
  const mockScbConfigured = vi.mocked(isScbConfigured)
  const mockCreateScb = vi.mocked(createScbClient)
  const lookupByOrgNumber = vi.fn()

  // SCB's row for an ideell förening: the columns the register answers with.
  const scbRow = {
    OrgNr: '8024811658',
    Företagsnamn: 'SEGELSÄLLSKAPET GAMBIT',
    'Juridisk form': 'Ideell förening',
    'Juridisk form, kod': '61',
    PostAdress: 'Hamnvägen 3',
    PostNr: '76140',
    PostOrt: 'Norrtälje',
    'Företagsstatus, kod': '1',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockSearch.mockResolvedValue(null)
    lookupByOrgNumber.mockReset()
    mockCreateScb.mockReturnValue({ lookupByOrgNumber } as never)
  })

  it('answers the miss with the registry hint when SCB knows the org number', async () => {
    mockScbConfigured.mockReturnValue(true)
    lookupByOrgNumber.mockResolvedValue({
      found: true,
      peOrgNr: '168024811658',
      row: scbRow,
      facts: factsFromScbCompany(scbRow),
      fetchedAt: '2026-09-18T08:00:00.000Z',
    })

    const res = await lookupHandler(makeRequest('802481-1658'))
    expect(res.status).toBe(404)
    expect(lookupByOrgNumber).toHaveBeenCalledWith('8024811658')
    await expect(res.json()).resolves.toEqual({
      error: 'Company not found',
      registry: {
        source: 'scb',
        companyName: 'Segelsällskapet Gambit',
        legalEntityType: 'Ideell förening',
        address: { street: 'Hamnvägen 3', postalCode: '76140', city: 'Norrtälje' },
        registration: { fTax: null, vat: null },
      },
    })
  })

  it('stays a plain miss when SCB is not configured here', async () => {
    mockScbConfigured.mockReturnValue(false)
    const res = await lookupHandler(makeRequest('802481-1658'))
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Company not found' })
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('never asks SCB about a personnummer', async () => {
    mockScbConfigured.mockReturnValue(true)
    const res = await lookupHandler(makeRequest('19850420-1234'))
    expect(res.status).toBe(404)
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('stays a plain miss when SCB has no row or the call fails', async () => {
    mockScbConfigured.mockReturnValue(true)
    lookupByOrgNumber.mockResolvedValueOnce({ found: false, peOrgNr: '168024811658', row: null, facts: [], fetchedAt: '' })
    await expect((await lookupHandler(makeRequest('802481-1658'))).json()).resolves.toEqual({
      error: 'Company not found',
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    lookupByOrgNumber.mockRejectedValueOnce(new Error('scb down'))
    await expect((await lookupHandler(makeRequest('802481-1658'))).json()).resolves.toEqual({
      error: 'Company not found',
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
