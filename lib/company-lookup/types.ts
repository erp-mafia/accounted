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
 * Generic company lookup result: provider-agnostic.
 * Defined in core so onboarding components can import it without
 * violating the CI constraint (no core → @/extensions/ imports).
 *
 * `fiscalYear` carries the current fiscal-year configuration when the
 * provider reports one: used by onboarding to skip manual MM-DD entry.
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
  /**
   * Bolagsverket legal entity type code: "AB", "EF", "HB", "KB", etc.
   * Onboarding maps the supported codes to `EntityType` ('aktiebolag',
   * 'enskild_firma') to pre-select Step 1's radio for deep-link users.
   * Optional: providers without this info or for unsupported types leave
   * it null and the user picks manually.
   */
  legalEntityType?: string | null
  /**
   * Company registration date as a millisecond epoch. TIC's search API
   * natively returns Unix seconds; the TIC extension converts to ms at the
   * boundary so consumers can feed this straight into `new Date()`.
   * Onboarding Step 3 uses this to infer `is_first_fiscal_year`: when the
   * company was registered less than 12 months ago, we pre-check the
   * first-year toggle and seed `first_year_start` from the registration
   * month. Optional: null when TIC didn't return it.
   */
  registrationDate?: number | null
}

/**
 * One hit from a free-text company search (onboarding's orgnr field also
 * accepts a name). Carries the org number the hit resolves to alongside the
 * same lookup result `/lookup` would return for it, so picking a hit costs
 * no second provider call.
 */
export interface CompanySearchHit {
  orgNumber: string
  result: CompanyLookupResult
}

/**
 * Shortest free-text query the search accepts. Shared by the client (which
 * shakes the field instead of calling) and the TIC route (which answers 400)
 * so the two never disagree on what is worth a provider call.
 */
export const COMPANY_SEARCH_MIN_CHARS = 3
