import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/tic-client', () => ({
  searchCompanyByOrgNumber: vi.fn(),
  // The handler no longer calls these: kept mocked so the import doesn't
  // throw and so we can assert below that they're NOT invoked.
  getBankAccounts: vi.fn(),
  getIndustryCodes: vi.fn(),
  getEmails: vi.fn(),
  getPhones: vi.fn(),
  getCompanyPurpose: vi.fn(),
  getSignatory: vi.fn(),
  getCompanyDocuments: vi.fn(),
  getFiscalYears: vi.fn(),
  getPayrolls: vi.fn(),
  getRepresentatives: vi.fn(),
  getCompanyStatus: vi.fn(),
  getBeneficialOwners: vi.fn(),
}))

import { ticExtension } from '../index'
import {
  searchCompanyByOrgNumber,
  getBankAccounts,
  getIndustryCodes,
  getEmails,
  getPhones,
  getCompanyPurpose,
  getCompanyDocuments,
  getFiscalYears,
  getPayrolls,
  getSignatory,
  getRepresentatives,
  getCompanyStatus,
  getBeneficialOwners,
} from '../lib/tic-client'
import type { TICCompanyDocument } from '../lib/tic-types'

const mockSearch = vi.mocked(searchCompanyByOrgNumber)
const mockBank = vi.mocked(getBankAccounts)
const mockIndustries = vi.mocked(getIndustryCodes)
const mockEmails = vi.mocked(getEmails)
const mockPhones = vi.mocked(getPhones)
const mockPurpose = vi.mocked(getCompanyPurpose)
const mockSignatory = vi.mocked(getSignatory)
const mockDocuments = vi.mocked(getCompanyDocuments)
const mockFiscalYears = vi.mocked(getFiscalYears)
const mockPayrolls = vi.mocked(getPayrolls)
const mockRepresentatives = vi.mocked(getRepresentatives)
const mockStatus = vi.mocked(getCompanyStatus)
const mockBeneficialOwners = vi.mocked(getBeneficialOwners)

function makeRequest(orgNumber?: string): Request {
  const url = orgNumber
    ? `http://localhost/api/extensions/ext/tic/profile?org_number=${encodeURIComponent(orgNumber)}`
    : 'http://localhost/api/extensions/ext/tic/profile'
  return new Request(url)
}

const profileHandler = ticExtension.apiRoutes![1].handler

// The search doc now carries everything we used to pull from dedicated v2
// endpoints: sniCodes, bankAccounts, emailAddresses, phoneNumbers,
// mostRecentSignatory: at the top level. /profile reads those directly.
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
    streetAddress: 'Storgatan 1',
    postalCode: '111 22',
    city: 'Stockholm',
  },
  isRegisteredForFTax: true,
  isRegisteredForVAT: true,
  isRegisteredForPayroll: false,
  isCeased: false,
  activityStatus: 'isActive',
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
  sniCodes: [
    { rank: 1, sni_2007Code: '62010', sni_2007Name: 'Dataprogrammering', sni_2007Section: 'J' },
  ],
  bankAccounts: [{ accountNumber: '1234567', bankAccountType: 'bankgiro' }],
  emailAddresses: [{ emailAddress: 'info@test.se', emailAddressType: 'general' }],
  phoneNumbers: [{ phoneNumberFormatted: '08-1234567' }],
  mostRecentSignatory: {
    signatureDescription: 'Firman tecknas av styrelsen.',
    firstSeenAt: 1700000000,
  },
}

function mockKeptSupplementary() {
  mockBeneficialOwners.mockResolvedValue([])
  mockDocuments.mockResolvedValue([
    {
      id: 'FRF_abc123',
      type: 'annualReport',
      financialReportMetadata: {
        arrivalDate: '2024-06-15',
        registrationDate: '2024-07-01',
        periodStart: '2023-01-01',
        periodEnd: '2023-12-31',
        isInterimReport: false,
        isConsolidatedAccounts: false,
        auditor: 'Jane Auditor',
        auditorFullName: 'Jane Auditor (FAR)',
        auditCompanyName: 'Big Audit AB',
      },
    },
    {
      id: 'FRF_xyz999',
      type: 'minutes',
      financialReportMetadata: {},
    },
  ])
  mockFiscalYears.mockResolvedValue([
    {
      startMonthDay: '01-01',
      endMonthDay: '12-31',
      startEndDescription: 'Jan-Dec',
      lastUpdatedAtUtc: '2024-06-01T00:00:00Z',
    },
    {
      startMonthDay: '07-01',
      endMonthDay: '06-30',
      startEndDescription: 'Jul-Jun',
      lastUpdatedAtUtc: '2020-01-01T00:00:00Z',
    },
  ])
  mockPayrolls.mockResolvedValue({
    payroll2: [
      {
        companyPayroll2Id: 1,
        periodStart: '2023-01-01',
        periodEnd: '2023-12-31',
        numberOfEmployees: 12,
        sumPayrollTax: 250_000,
        calculatedPersonnelCosts: 6_000_000,
        personnelCostsInAnnualReport: 5_950_000,
        deviation: 0.008,
        numberOfLateFeesForPeriod: 0,
      },
    ],
    payrolls: [],
  })
  mockRepresentatives.mockResolvedValue({
    representativeInformation: [
      {
        companyRepresentativeInformationId: 1,
        numberOfBoardMembers: 3,
        numberOfDeputyBoardMembers: 1,
        hasVacancy: false,
        lastUpdatedAtUtc: '2024-06-01T00:00:00Z',
      },
    ],
    representatives: [
      {
        companyPersonId: 100,
        positionType: 'ceo',
        positionDescription: 'Verkställande direktör',
        positionStart: '2022-01-01T00:00:00Z',
        positionEnd: null,
        roleByPersonName: 'Anna Andersson',
      },
      {
        companyPersonId: 101,
        positionType: 'boardMember',
        positionDescription: 'Styrelseledamot',
        positionStart: '2020-06-01T00:00:00Z',
        positionEnd: '2021-12-31T00:00:00Z',
        roleByPersonName: 'Old Member',
      },
    ],
  })
  mockStatus.mockResolvedValue([
    {
      companyStatusId: 1,
      companyStatusType: 'isActive',
      companyStatusDescription: { code: 'isActive', name_SE: 'Aktivt', isCeased: false },
      statusDate: '2023-01-01T00:00:00Z',
      statusColor: 'green',
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
    mockKeptSupplementary()

    const res = await profileHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(200)

    const { data } = await res.json()
    expect(data.companyId).toBe(42)
    expect(data.orgNumber).toBe('5560360793')
    expect(data.companyName).toBe('Test AB')
    expect(data.legalEntityType).toBe('AB')
    expect(data.activityStatus).toBe('isActive')
    expect(data.purpose).toBe('Software development')
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
      { type: 'bankgiro', accountNumber: '1234567', bic: null },
    ])
    expect(data.fetchedAt).toBeDefined()
  })

  it('does NOT fan out to bank/industries/emails/phones/purposes/signatory anymore', async () => {
    mockSearch.mockResolvedValue(mockDoc)
    mockKeptSupplementary()

    await profileHandler(makeRequest('556036-0793'))

    expect(mockBank).not.toHaveBeenCalled()
    expect(mockIndustries).not.toHaveBeenCalled()
    expect(mockEmails).not.toHaveBeenCalled()
    expect(mockPhones).not.toHaveBeenCalled()
    expect(mockPurpose).not.toHaveBeenCalled()
    expect(mockSignatory).not.toHaveBeenCalled()
  })

  it('maps activityStatus to "ceased" when isCeased is true', async () => {
    mockSearch.mockResolvedValue({ ...mockDoc, isCeased: true, activityStatus: 'isNoLongerActive' })
    mockKeptSupplementary()

    const res = await profileHandler(makeRequest('556036-0793'))
    const { data } = await res.json()
    expect(data.activityStatus).toBe('ceased')
  })

  it('includes financial summary from company document', async () => {
    mockSearch.mockResolvedValue(mockDoc)
    mockKeptSupplementary()

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

  it('maps v2 documents (annualReport only) to financial-report summaries', async () => {
    mockSearch.mockResolvedValue(mockDoc)
    mockKeptSupplementary()

    const res = await profileHandler(makeRequest('556036-0793'))
    const { data } = await res.json()

    expect(data.financialReports).toHaveLength(1)
    expect(data.financialReports[0]).toMatchObject({
      title: 'Årsredovisning',
      periodStart: '2023-01-01',
      periodEnd: '2023-12-31',
      arrivalDate: '2024-06-15',
      isInterimReport: false,
      isAudited: true,
    })
  })

  it('handles missing financial summary gracefully', async () => {
    const docWithoutFinancials = { ...mockDoc, mostRecentFinancialSummary: undefined }
    mockSearch.mockResolvedValue(docWithoutFinancials)
    mockKeptSupplementary()

    const res = await profileHandler(makeRequest('556036-0793'))
    const { data } = await res.json()

    expect(data.financials).toBeNull()
  })

  it('degrades gracefully when remaining Phase 2 calls fail', async () => {
    // Doc still provides bankAccounts/sniCodes/email/phone/purpose/signatory:
    // only the kept Phase 2 endpoints can now fail.
    mockSearch.mockResolvedValue(mockDoc)
    mockDocuments.mockRejectedValue(new Error('timeout'))
    mockFiscalYears.mockRejectedValue(new Error('timeout'))
    mockPayrolls.mockRejectedValue(new Error('timeout'))
    mockRepresentatives.mockRejectedValue(new Error('timeout'))
    mockStatus.mockRejectedValue(new Error('timeout'))
    mockBeneficialOwners.mockRejectedValue(new Error('timeout'))

    const res = await profileHandler(makeRequest('556036-0793'))
    expect(res.status).toBe(200)

    const { data } = await res.json()
    expect(data.companyName).toBe('Test AB')
    // These come from the search doc, so they survive Phase 2 failures
    expect(data.bankAccounts).toHaveLength(1)
    expect(data.sniCodes).toHaveLength(1)
    expect(data.email).toBe('info@test.se')
    expect(data.phone).toBe('08-1234567')
    expect(data.purpose).toBe('Software development')
    expect(data.signatory).toEqual([{ description: 'Firman tecknas av styrelsen.' }])
    // These come from Phase 2, so they degrade to empty
    expect(data.financialReports).toEqual([])
    expect(data.fiscalYear).toBeNull()
    expect(data.fiscalYearHistory).toEqual([])
    expect(data.board).toBeNull()
    expect(data.representatives).toEqual([])
    expect(data.payrolls).toEqual([])
    expect(data.statuses).toEqual([])
  })

  it('exposes fiscal year, payroll history, signatory, board, representatives and status', async () => {
    mockSearch.mockResolvedValue(mockDoc)
    mockKeptSupplementary()

    const res = await profileHandler(makeRequest('556036-0793'))
    const { data } = await res.json()

    expect(data.fiscalYear).toEqual({
      startMonthDay: '01-01',
      endMonthDay: '12-31',
      description: 'Jan-Dec',
    })
    expect(data.fiscalYearHistory).toHaveLength(2)
    expect(data.fiscalYearHistory[0]).toMatchObject({ startMonthDay: '01-01', endMonthDay: '12-31' })

    expect(data.signatory).toEqual([{ description: 'Firman tecknas av styrelsen.' }])

    expect(data.board).toMatchObject({
      numberOfBoardMembers: 3,
      numberOfDeputyBoardMembers: 1,
      hasVacancy: false,
    })

    expect(data.representatives).toHaveLength(1)
    expect(data.representatives[0]).toMatchObject({
      name: 'Anna Andersson',
      positionType: 'ceo',
      positionDescription: 'Verkställande direktör',
    })

    expect(data.payrolls).toHaveLength(1)
    expect(data.payrolls[0]).toMatchObject({
      numberOfEmployees: 12,
      sumPayrollTax: 250_000,
      deviation: 0.008,
    })

    expect(data.statuses).toEqual([
      {
        code: 'isActive',
        description: 'Aktivt',
        color: 'green',
        statusDate: '2023-01-01T00:00:00Z',
        isCeased: false,
      },
    ])
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
    mockDocuments.mockResolvedValue(null)
    mockFiscalYears.mockResolvedValue(null)
    mockPayrolls.mockResolvedValue(null)
    mockRepresentatives.mockResolvedValue(null)
    mockStatus.mockResolvedValue(null)
    mockBeneficialOwners.mockResolvedValue(null)

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
    expect(data.fiscalYear).toBeNull()
    expect(data.fiscalYearHistory).toEqual([])
    expect(data.signatory).toEqual([])
    expect(data.board).toBeNull()
    expect(data.representatives).toEqual([])
    expect(data.payrolls).toEqual([])
    expect(data.statuses).toEqual([])
  })
})
