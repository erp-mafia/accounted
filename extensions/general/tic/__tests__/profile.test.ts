import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/tic-client', () => ({
  searchCompanyByOrgNumber: vi.fn(),
  getBankAccounts: vi.fn(),
  getSNICodes: vi.fn(),
  getEmails: vi.fn(),
  getPhones: vi.fn(),
  getCompanyPurpose: vi.fn(),
  getFinancialReportSummaries: vi.fn(),
  getBeneficialOwners: vi.fn(),
}))

import { ticExtension } from '../index'
import {
  searchCompanyByOrgNumber,
  getBankAccounts,
  getSNICodes,
  getEmails,
  getPhones,
  getCompanyPurpose,
  getFinancialReportSummaries,
  getBeneficialOwners,
} from '../lib/tic-client'
import type { TICCompanyDocument } from '../lib/tic-types'

const mockSearch = vi.mocked(searchCompanyByOrgNumber)
const mockBank = vi.mocked(getBankAccounts)
const mockSNI = vi.mocked(getSNICodes)
const mockEmails = vi.mocked(getEmails)
const mockPhones = vi.mocked(getPhones)
const mockPurpose = vi.mocked(getCompanyPurpose)
const mockReports = vi.mocked(getFinancialReportSummaries)
const mockBeneficialOwners = vi.mocked(getBeneficialOwners)

function makeRequest(orgNumber?: string): Request {
  const url = orgNumber
    ? `http://localhost/api/extensions/ext/tic/profile?org_number=${encodeURIComponent(orgNumber)}`
    : 'http://localhost/api/extensions/ext/tic/profile'
  return new Request(url)
}

const profileHandler = ticExtension.apiRoutes![1].handler

const mockDoc: TICCompanyDocument = {
  companyId: 42,
  registrationNumber: '5560360793',
  names: [
    { nameOrIdentifier: 'Registered Name', companyNamingType: 'registeredName' },
    { nameOrIdentifier: 'Test AB', companyNamingType: 'name' },
  ],
  legalEntityType: 'AB',
  registrationDate: 946684800000,
  mostRecentPurpose: 'Software development',
  mostRecentRegisteredAddress: {
    street: 'Storgatan 1',
    postalCode: '111 22',
    city: 'Stockholm',
  },
  isRegisteredForFTax: true,
  isRegisteredForVAT: true,
  isRegisteredForPayroll: false,
  activityStatus: 'active',
  cSector: { categoryCode: 1, categoryCodeDescription: 'Privat sektor' },
  cNbrEmployeesInterval: { categoryCode: 3, categoryCodeDescription: '10-49' },
  cTurnoverInterval: { categoryCode: 5, categoryCodeDescription: '10-50 MSEK' },
  mostRecentFinancialSummary: {
    periodStart: 1672531200000,
    periodEnd: 1704067200000,
    isAudited: true,
    rs_NetSalesK: 15000,
    rs_OperatingProfitOrLossK: 2500,
    bs_TotalAssetsK: 8000,
    fn_NumberOfEmployees: 12,
    km_OperatingMargin: 16.7,
    km_NetProfitMargin: 12.3,
    km_EquityAssetsRatio: 45.2,
  },
}

function mockAllSupplementary() {
  mockBank.mockResolvedValue([
    { bankAccountType: 1, accountNumber: '123-456', swift_BIC: undefined },
  ])
  mockSNI.mockResolvedValue([
    { sni_2007Code: '62010', sni_2007Name: 'Dataprogrammering' },
  ])
  mockEmails.mockResolvedValue([{ emailAddress: 'info@test.se' }])
  mockPhones.mockResolvedValue([{ phoneNumber: '08-1234567' }])
  mockPurpose.mockResolvedValue([
    { companyPurposeId: 1, purpose: 'Försäljning av drycker' },
  ])
  mockBeneficialOwners.mockResolvedValue({ notifications: [], exempts: [] })
  mockReports.mockResolvedValue([
    {
      financialReportSummaryId: 1,
      title: 'Årsredovisning 2023',
      arrivalDate: '2024-06-15',
      periodStart: '2023-01-01',
      periodEnd: '2023-12-31',
      isAudited: true,
      auditOpinion: 'Ren',
    },
  ])
}

describe('TIC profile route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when org_number is missing', async () => {
    const res = await profileHandler(makeRequest())
    expect(res.status).toBe(400)
  })

  it('returns 404 when company not found', async () => {
    mockSearch.mockResolvedValue(null)
    const res = await profileHandler(makeRequest('000000-0000'))
    expect(res.status).toBe(404)
  })

  it('returns full profile on happy path', async () => {
    mockSearch.mockResolvedValue(mockDoc)
    mockAllSupplementary()

    const res = await profileHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(200)

    const { data } = await res.json()
    expect(data.companyId).toBe(42)
    expect(data.orgNumber).toBe('5560360793')
    expect(data.companyName).toBe('Test AB')
    expect(data.legalEntityType).toBe('AB')
    expect(data.activityStatus).toBe('active')
    expect(data.purpose).toBe('Försäljning av drycker')
    expect(data.address).toEqual({
      street: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
    })
    expect(data.registration).toEqual({ fTax: true, vat: true, payroll: false })
    expect(data.sector).toEqual({ code: 1, description: 'Privat sektor' })
    expect(data.employeeRange).toBe('10-49')
    expect(data.turnoverRange).toBe('10-50 MSEK')
    expect(data.email).toBe('info@test.se')
    expect(data.phone).toBe('08-1234567')
    expect(data.sniCodes).toEqual([{ code: '62010', name: 'Dataprogrammering' }])
    expect(data.bankAccounts).toEqual([
      { type: 'bankgiro', accountNumber: '123-456', bic: null },
    ])
    expect(data.fetchedAt).toBeDefined()
  })

  it('includes financial summary from company document', async () => {
    mockSearch.mockResolvedValue(mockDoc)
    mockAllSupplementary()

    const res = await profileHandler(makeRequest('556036-0793'))
    const { data } = await res.json()

    expect(data.financials).toEqual({
      periodStart: 1672531200000,
      periodEnd: 1704067200000,
      netSalesK: 15000,
      operatingProfitK: 2500,
      totalAssetsK: 8000,
      numberOfEmployees: 12,
      operatingMargin: 16.7,
      netProfitMargin: 12.3,
      equityAssetsRatio: 45.2,
    })
  })

  it('includes financial report summaries', async () => {
    mockSearch.mockResolvedValue(mockDoc)
    mockAllSupplementary()

    const res = await profileHandler(makeRequest('556036-0793'))
    const { data } = await res.json()

    expect(data.financialReports).toHaveLength(1)
    expect(data.financialReports[0]).toMatchObject({
      title: 'Årsredovisning 2023',
      isAudited: true,
      auditOpinion: 'Ren',
    })
  })

  it('handles missing financial summary gracefully', async () => {
    const docWithoutFinancials = { ...mockDoc, mostRecentFinancialSummary: undefined }
    mockSearch.mockResolvedValue(docWithoutFinancials)
    mockAllSupplementary()

    const res = await profileHandler(makeRequest('556036-0793'))
    const { data } = await res.json()

    expect(data.financials).toBeNull()
  })

  it('handles partial Phase 2 failures gracefully', async () => {
    mockSearch.mockResolvedValue(mockDoc)
    mockBank.mockRejectedValue(new Error('timeout'))
    mockSNI.mockResolvedValue([{ sni_2007Code: '62010', sni_2007Name: 'Dataprogrammering' }])
    mockEmails.mockRejectedValue(new Error('timeout'))
    mockPhones.mockResolvedValue(null)
    mockPurpose.mockRejectedValue(new Error('timeout'))
    mockReports.mockRejectedValue(new Error('timeout'))

    const res = await profileHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(200)

    const { data } = await res.json()
    expect(data.companyName).toBe('Test AB')
    expect(data.bankAccounts).toEqual([])
    expect(data.sniCodes).toHaveLength(1)
    expect(data.email).toBeNull()
    expect(data.phone).toBeNull()
    expect(data.purpose).toBe('Software development') // falls back to mostRecentPurpose
    expect(data.financialReports).toEqual([])
  })

  it('sets financials to null when no optional fields present', async () => {
    const minimalDoc: TICCompanyDocument = {
      companyId: 99,
      registrationNumber: '1234567890',
      names: [{ nameOrIdentifier: 'Minimal AB', companyNamingType: 'name' }],
      legalEntityType: 'AB',
      registrationDate: 0,
    }
    mockSearch.mockResolvedValue(minimalDoc)
    mockBank.mockResolvedValue(null)
    mockSNI.mockResolvedValue(null)
    mockEmails.mockResolvedValue(null)
    mockPhones.mockResolvedValue(null)
    mockPurpose.mockResolvedValue(null)
    mockReports.mockResolvedValue(null)

    const res = await profileHandler(makeRequest('1234567890'))
    const { data } = await res.json()

    expect(data.companyName).toBe('Minimal AB')
    expect(data.activityStatus).toBeNull()
    expect(data.address).toBeNull()
    expect(data.registration).toEqual({ fTax: false, vat: false, payroll: false })
    expect(data.sector).toBeNull()
    expect(data.employeeRange).toBeNull()
    expect(data.turnoverRange).toBeNull()
    expect(data.financials).toBeNull()
    expect(data.financialReports).toEqual([])
  })
})
