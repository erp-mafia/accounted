/** Search response wrapper */
export interface TICCompanyResponse {
  facet_counts: unknown[]
  found: number
  hits: Array<{
    document: TICCompanyDocument
  }>
}

/** Full company document from TIC search */
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
    street?: string
    streetAddress?: string
    postalCode?: string
    city?: string
    countryCodeAlpha3?: string
  }
  isRegisteredForVAT?: boolean
  isRegisteredForFTax?: boolean
  isRegisteredForPayroll?: boolean
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
}

/** Bank account from /bank-accounts endpoint */
export interface TICBankAccount {
  bankAccountType?: number // 0=Unknown, 1=Bankgiro, 2=Plusgiro, 3=IBAN, etc.
  accountNumber?: string
  swift_BIC?: string
  firstSeenAtUtc?: string
  lastSeenAtUtc?: string
}

/** SNI code from /se/sni endpoint */
export interface TICSNICode {
  sni_2007Code?: string
  sni_2007Name?: string
  sni_2007Section?: string
  isPrimary?: boolean
}

/** Email address from /email-addresses endpoint */
export interface TICEmail {
  emailAddress?: string
  firstSeenAtUtc?: string
  lastSeenAtUtc?: string
}

/** Phone number from /phone-numbers endpoint */
export interface TICPhone {
  phoneNumber?: string
  firstSeenAtUtc?: string
  lastSeenAtUtc?: string
}

/** Company purpose from /purpose endpoint */
export interface TICCompanyPurpose {
  companyPurposeId?: number
  purpose?: string
  firstSeenAtUtc?: string
  lastUpdatedAtUtc?: string
}

/** Raw Bolagsverket beneficial-owner notification record — one per
 * registration event. The latest active notification is what we care
 * about; older ones describe ownership changes over time. */
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

/** Top-level shape returned by /datasets/companies/{id}/se/beneficial-owners */
export interface TICBeneficialOwnerResponse {
  notifications?: TICBeneficialOwnerNotificationRaw[] | null
  exempts?: { from?: string | null; to?: string | null }[] | null
}

/** Financial report summary from /financial-report-summaries endpoint */
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

/** Flattened beneficial owner record — verklig huvudman per
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
  beneficialOwners: TICBeneficialOwner[]
  // Whether the company is exempt from beneficial-owner registration
  // (typically state-owned or stock-exchange-listed companies).
  beneficialOwnerExempt: boolean
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
