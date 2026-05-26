/**
 * A person's role/position in a Swedish company, from BankID enrichment.
 * Defined in core so onboarding components can import it without
 * violating the CI constraint (no core → @/extensions/ imports).
 */
export interface EnrichmentCompanyRole {
  companyId: number
  companyRegistrationNumber: string
  legalName: string
  legalEntityType: string
  positionTypes: string[]
  positionDescriptions: string[]
  positionStart: string
  positionEnd: string | null
  companyStatus: string
  signatureDescription?: string
}

/**
 * Generic company lookup result — provider-agnostic.
 * Defined in core so onboarding components can import it without
 * violating the CI constraint (no core → @/extensions/ imports).
 *
 * `fiscalYear` carries the current fiscal-year configuration when the
 * provider reports one — used by onboarding to skip manual MM-DD entry.
 * Always optional: providers that don't return it (or that fail
 * partially) must still produce a valid result.
 */
export interface CompanyLookupResult {
  companyName: string
  isCeased: boolean
  address: { street: string | null; postalCode: string | null; city: string | null } | null
  registration: { fTax: boolean; vat: boolean }
  bankAccounts: { type: string; accountNumber: string; bic: string | null }[]
  email: string | null
  phone: string | null
  sniCodes: { code: string; name: string }[]
  fiscalYear?: { startMonthDay: string | null; endMonthDay: string | null } | null
}
