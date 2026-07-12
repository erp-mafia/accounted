/** Search response wrapper (Typesense). v2 keeps the same hits/found shape. */
export interface TICCompanyResponse {
  facet_counts: unknown[]
  found: number
  hits: Array<{
    document: TICCompanyDocument
  }>
}

/**
 * Company document from the Typesense `/search-public/companies` index.
 *
 * v2 (Lens) added `isCeased: boolean` as a top-level boolean and changed
 * `activityStatus` from a free-form string to an enum
 * (`hasNeverBeenActive | isActive | isNoLongerActive | unknown`). Existing
 * fields we read are unchanged.
 */
export interface TICCompanyDocument {
  companyId: number
  registrationNumber: string
  names: Array<{
    nameOrIdentifier: string
    companyNamingType: string
    companyNameDecidedAt?: number
    firstSeenAt?: number
  }>
  legalEntityType: string
  registrationDate: number
  mostRecentPurpose?: string
  mostRecentRegisteredAddress?: {
    streetAddress?: string
    postalCode?: string
    city?: string
    countryCodeAlpha3?: string
  }
  isRegisteredForVAT?: boolean
  isRegisteredForFTax?: boolean
  isRegisteredForPayroll?: boolean
  isCeased?: boolean
  activityStatus?: string
  cSector?: {
    categoryCode: number
    categoryCodeDescription: string
  }
  cOwnership?: {
    categoryCode: number
    categoryCodeDescription: string
  }
  cNbrEmployeesInterval?: {
    categoryCode: number
    categoryCodeDescription: string
  }
  cTurnoverInterval?: {
    categoryCode: number
    categoryCodeDescription: string
  }
  mostRecentFinancialSummary?: {
    periodStart: number
    periodEnd: number
    isAudited?: boolean
    rs_NetSalesK?: number
    rs_OperatingProfitOrLossK?: number
    bs_TotalAssetsK?: number
    fn_NumberOfEmployees?: number
    km_OperatingMargin?: number
    km_NetProfitMargin?: number
    km_EquityAssetsRatio?: number
  }
  // Top-level fields the Lens search index already returns alongside the
  // company core. /lookup reads these directly instead of fanning out to
  // dedicated v2 endpoints: saves 5 calls per invocation.
  sniCodes?: Array<{
    rank?: number
    sni_2007Code?: string
    sni_2007Name?: string
    sni_2007Section?: string
  }>
  bankAccounts?: Array<{
    accountNumber?: string | number
    bankAccountType?: string
  }>
  emailAddresses?: Array<{
    emailAddress?: string
    emailAddressType?: string
  }>
  phoneNumbers?: Array<{
    phoneNumberFormatted?: string
    e164PhoneNumber?: string
    phoneNumberType?: string
  }>
  mostRecentSignatory?: {
    signatureDescription?: string
    firstSeenAt?: number
  }
}

/**
 * v2 `/companies/{id}/bank-accounts` returns only Bankgirot numbers
 * (`Bankgironumber_Dto[]`), not full bank accounts. v1's IBAN / plusgiro
 * / generic bank-account coverage is gone from this endpoint.
 */
export interface TICBankgirot {
  bankgironumber?: number | null
  terminated?: boolean | null
  name?: string | null
  isTaxBankgironumber?: boolean | null
  updatedAt?: string | null
}

/** v2 `/companies/{id}/industries` returns `CompanyIndustryCode_Dto[]`. */
export interface TICIndustryCode {
  companyIndustryCodeType?: 'sni2007' | 'sni2025' | 'other' | string
  industryCode?: string | null
  description?: string | null
  rank?: number | null
}

/** v2 `/companies/{id}/email-addresses` returns `View_CompanyEmail[]`. */
export interface TICEmail {
  emailAddress?: string | null
  firstSeenAtUtc?: string | null
  lastSeenAtUtc?: string | null
}

/** v2 `/companies/{id}/phone-numbers` returns `CompanyPhoneNumber_Dto[]`. */
export interface TICPhone {
  phoneNumberFormatted?: string | null
  e164PhoneNumber?: string | null
  firstSeenAtUtc?: string | null
  lastSeenAtUtc?: string | null
}

/** v2 `/companies/{id}/purposes` returns `CompanyPurpose_Dto[]`. */
export interface TICCompanyPurpose {
  companyPurposeId?: number
  purpose?: string
  firstSeenAtUtc?: string
  lastUpdatedAtUtc?: string
}

/**
 * Raw Bolagsverket beneficial-owner notification record: one per
 * registration event. The latest active notification is what we care
 * about; older ones describe ownership changes over time.
 *
 * v2 shape: matches `BeneficialOwnerNotification_Dto`. Personnummer
 * (`personalIdentityNumber`) is omitted from this interface: we never
 * cache it, and the rest of the codebase has no need for it.
 */
export interface TICBeneficialOwnerNotificationRaw {
  fromDate?: string | null
  notificationDate?: string | null
  statusCode?: string | null
  statusDescription?: string | null
  bolagsverket_BeneficialOwner?: {
    firstName?: string | null
    middleName?: string | null
    lastName?: string | null
    fallbackName?: string | null
    citizenshipCountryCode?: string | null
    countryOfResidenceCode?: string | null
    extentCode?: string | null
    extentDescription?: string | null
  }[]
}

/**
 * v2 `/companies/{id}/beneficial-owners` returns
 * `BeneficialOwnerNotification_Dto[]` directly: there is no wrapper.
 * v1's wrapper carried an `exempts` array; v2 dropped it (no equivalent
 * endpoint exists in the Lens spec), so the cached profile no longer
 * surfaces an exempt flag.
 */
export type TICBeneficialOwnerResponse = TICBeneficialOwnerNotificationRaw[]

/**
 * Document type enum from v2 `/companies/{id}/documents`. The endpoint
 * returns every document the company has filed (annual reports, audit
 * reports, articles of association, minutes, etc.); we filter on this
 * field to extract the financial-report subset that TicWorkspace shows.
 */
export type TICDocumentType =
  | 'annualReport'
  | 'interimReport'
  | 'auditReport'
  | 'articlesOfAssociation'
  | 'economicPlan'
  | 'certificateOfApproval'
  | 'minutes'
  | 'statutes'
  | 'receivedButNotRegistered'
  | 'receivedButTerminated'
  | 'other'

/**
 * v2 `/companies/{id}/documents` row. The metadata that used to live as
 * flat fields on v1's `/financial-report-summaries` rows now lives nested
 * under `financialReportMetadata`. Files are fetched separately via
 * `/documents/{id}` using the FRF_-prefixed `id`.
 */
export interface TICDocument {
  id?: string | null
  type?: TICDocumentType | string
  financialReportMetadata?: {
    arrivalDate?: string | null
    registrationDate?: string | null
    periodStart?: string | null
    periodEnd?: string | null
    isInterimReport?: boolean | null
    isConsolidatedAccounts?: boolean | null
    auditor?: string | null
    auditorFullName?: string | null
    auditCompanyName?: string | null
  }
}

/**
 * Normalized financial-report row consumed by TicWorkspace. v1's TIC
 * endpoint returned this shape directly; in v2 we derive it from
 * `TICDocument` (filtered to `type === 'annualReport'`). Keeping the
 * shape stable means TicWorkspace doesn't need to change.
 */
export interface TICFinancialReportSummary {
  financialReportSummaryId?: number
  title?: string
  arrivalDate?: string
  registrationDate?: string
  periodStart?: string
  periodEnd?: string
  isInterimReport?: boolean
  isConsolidatedAccounts?: boolean
  isAudited?: boolean
  auditOpinion?: string
}

/** Flattened beneficial owner record: verklig huvudman per
 * Lag (2017:631). Personnummer intentionally omitted to keep PII out of the
 * cached profile; we only need name + ownership extent for downstream use
 * (e.g. dropping "are you the sole owner?" verification questions). */
export interface TICBeneficialOwner {
  name: string
  // Bolagsverket extent codes describe the share of ownership / control,
  // e.g. "OWNS_25_TO_50_PERCENT", "OWNS_OVER_50_PERCENT". Kept verbatim so
  // downstream Swedish-language formatting can map them.
  extentCode: string | null
  extentDescription: string | null
  citizenshipCountryCode: string | null
  countryOfResidenceCode: string | null
  registeredAt: string | null
}

/**
 * v2 `/companies/{id}/fiscal-years` returns `CompanyFiscalYear_Dto[]`.
 * Each row records a fiscal-year configuration the company has used.
 * `startMonthDay` / `endMonthDay` are strings like "01-01" / "12-31".
 */
export interface TICFiscalYear {
  companyFiscalYearId?: number
  companyId?: number
  startMonthDay?: string | null
  endMonthDay?: string | null
  startEndDescription?: string | null
  firstSeenAtUtc?: string | null
  lastUpdatedAtUtc?: string | null
}

/**
 * v2 `/companies/{id}/accounting-periods` returns
 * `CompanyAccountingPeriod_Dto[]`: history of period-end changes
 * (e.g. shifted year-end). Useful as a "this company changed its books"
 * indicator during onboarding.
 */
export interface TICAccountingPeriod {
  companyAccountingPeriodId?: number
  companyId?: number
  endingDatePriorToChange?: string | null
  endingDateAfterChange?: string | null
  firstSeenAtUtc?: string | null
  lastUpdatedAtUtc?: string | null
}

/**
 * v2 `/companies/{id}/payrolls` returns a wrapper with two arrays.
 * `payroll2` is the modern per-period breakdown with deviation vs the
 * annual-report personnel-cost line; `payrolls` is the legacy
 * Skatteverket MOMS/AG period totals.
 */
export interface TICPayroll2 {
  companyPayroll2Id?: number
  periodStart?: string | null
  periodEnd?: string | null
  payrollPeriods?: number | null
  sumPayrollTax?: number | null
  numberOfPeriods?: number | null
  numberOfPeriodsWithZero?: number | null
  personnelCostsInAnnualReport?: number | null
  calculatedPersonnelCosts?: number | null
  deviationInCosts?: number | null
  deviationInCostsChange?: number | null
  deviation?: number | null
  numberOfEmployees?: number | null
  numberOfLateFeesForPeriod?: number | null
  taxSurchangeAmountForPeriod?: number | null
  lastUpdatedAtUtc?: string | null
}

export interface TICPayrollMomsAg {
  skatteverket_MOMS_AGId?: number
  period?: number | null
  belopp?: number | null
  externtid?: number | null
  forandring?: number | null
  forandringProcent?: number | null
}

export interface TICPayrollSummary {
  payroll2?: TICPayroll2[]
  payrolls?: TICPayrollMomsAg[]
}

/**
 * v2 `/companies/{id}/signatory` returns `CompanySignatory_Dto[]`.
 * Each entry's `signatureDescription` is free-form Swedish text
 * describing firmateckning rules ("Firman tecknas av styrelsen.
 * Firman tecknas två i förening av ledamöterna.").
 */
export interface TICSignatory {
  companySignatoryId?: number
  companyId?: number
  signatureDescription?: string | null
  firstSeenAtUtc?: string | null
  lastSeenAtUtc?: string | null
  lastUpdatedAtUtc?: string | null
}

/**
 * v2 `/companies/{id}/representatives` returns a wrapper with two
 * arrays. `representativeInformation` is board-composition summary
 * (counts, vacancies); `representatives` is the per-person list with
 * positionType, dates, and (optionally) the person's name.
 */
export interface TICRepresentativeInfo {
  companyRepresentativeInformationId?: number
  numberOfBoardMembers?: number | null
  numberOfDeputyBoardMembers?: number | null
  hasVacancy?: boolean | null
  boardFromDate?: string | null
  missingCEODate?: string | null
  missingAuditor?: string | null
  boardNotFullyDate?: string | null
  lastChangeDate?: string | null
  lastUpdatedAtUtc?: string | null
}

export interface TICCompanyPerson {
  companyPersonId?: number
  positionType?: string | null
  positionDescription?: string | null
  positionStart?: string | null
  positionEnd?: string | null
  roleByPersonName?: string | null
  roleByPersonalIdentityNumber?: string | null
  roleByCompanyName?: string | null
  roleByCompanyRegistrationNumber?: string | null
  auditorTypeDescription?: string | null
  residenceLocationTypeDescription?: string | null
}

export interface TICRepresentatives {
  representativeInformation?: TICRepresentativeInfo[]
  representatives?: TICCompanyPerson[]
}

/**
 * v2 `/companies/{id}/status` returns `CompanyStatus_Dto[]`: current
 * and historical status entries (active, in liquidation, struck off,
 * etc.). Each entry has a `statusColor` (red/yellow/green/neutral) and
 * a human-readable `statusDescription` we can surface directly.
 */
export interface TICCompanyStatusEntry {
  companyStatusId?: number
  companyId?: number
  companyStatusType?: string
  companyStatusDescription?: {
    code?: string
    name_EN?: string | null
    name_SE?: string | null
    isCeased?: boolean | null
  }
  statusDate?: string | null
  statusDescription?: string | null
  statusData?: string | null
  statusDataDescription?: string | null
  firstSeenAtUtc?: string | null
  lastSeenAtUtc?: string | null
  lastUpdatedAtUtc?: string | null
  statusColor?: 'red' | 'yellow' | 'green' | 'neutral' | string
}

/** Normalized fiscal-year entry surfaced by /profile and /lookup. */
export interface TICProfileFiscalYear {
  startMonthDay: string | null
  endMonthDay: string | null
  description: string | null
}

/** Normalized signatory row surfaced by /profile. */
export interface TICProfileSignatory {
  description: string
}

/** Normalized representative row surfaced by /profile. */
export interface TICProfileRepresentative {
  name: string | null
  positionType: string | null
  positionDescription: string | null
  positionStart: string | null
  positionEnd: string | null
}

/** Normalized board-composition summary surfaced by /profile. */
export interface TICProfileBoardSummary {
  numberOfBoardMembers: number | null
  numberOfDeputyBoardMembers: number | null
  hasVacancy: boolean | null
  missingCEODate: string | null
  missingAuditor: string | null
  lastChangeDate: string | null
}

/** Normalized payroll period surfaced by /profile. */
export interface TICProfilePayrollPeriod {
  periodStart: string | null
  periodEnd: string | null
  numberOfEmployees: number | null
  sumPayrollTax: number | null
  calculatedPersonnelCosts: number | null
  personnelCostsInAnnualReport: number | null
  deviation: number | null
  numberOfLateFeesForPeriod: number | null
}

/** Normalized status entry surfaced by /profile and /lookup. */
export interface TICProfileStatus {
  code: string | null
  description: string | null
  color: 'red' | 'yellow' | 'green' | 'neutral' | null
  statusDate: string | null
  isCeased: boolean | null
}

/** Normalized company profile for workspace display */
export interface TICCompanyProfile {
  companyId: number
  orgNumber: string
  companyName: string
  legalEntityType: string
  registrationDate: number
  activityStatus: string | null
  purpose: string | null
  address: { street: string | null; postalCode: string | null; city: string | null } | null
  registration: { fTax: boolean; vat: boolean; payroll: boolean }
  sector: { code: number; description: string } | null
  employeeRange: string | null
  turnoverRange: string | null
  email: string | null
  phone: string | null
  sniCodes: { code: string; name: string }[]
  bankAccounts: { type: string; accountNumber: string; bic: string | null }[]
  // Owners registered as verklig huvudman. Empty when the company has none
  // (e.g. listed companies are exempt) or when the dataset returned nothing.
  // v1 used to expose an explicit `exempts` array distinguishing the two;
  // v2 dropped that, so we infer "no owners and no error" === "exempt or none"
  // without surfacing the distinction.
  beneficialOwners: TICBeneficialOwner[]
  financials: {
    periodStart: number
    periodEnd: number
    netSalesK: number | null
    operatingProfitK: number | null
    totalAssetsK: number | null
    numberOfEmployees: number | null
    operatingMargin: number | null
    netProfitMargin: number | null
    equityAssetsRatio: number | null
  } | null
  financialReports: TICFinancialReportSummary[]
  fiscalYear: TICProfileFiscalYear | null
  fiscalYearHistory: TICProfileFiscalYear[]
  signatory: TICProfileSignatory[]
  board: TICProfileBoardSummary | null
  representatives: TICProfileRepresentative[]
  payrolls: TICProfilePayrollPeriod[]
  statuses: TICProfileStatus[]
  fetchedAt: string
}

export class TICAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public code?: string
  ) {
    super(message)
    this.name = 'TICAPIError'
  }
}
