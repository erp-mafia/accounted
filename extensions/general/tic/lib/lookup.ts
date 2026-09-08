import { searchCompaniesByName, searchCompanyByOrgNumber } from './tic-client'
import type { TICCompanyDocument } from './tic-types'
import type { CompanyLookupResult, CompanySearchHit } from '@/lib/company-lookup/types'
import { normalizeOrgNumber, orgNumberKey } from '@/lib/invariants/org-number'

/**
 * Shared org-number → CompanyLookupResult lookup, used by both the /lookup
 * HTTP route (web onboarding) and the mcp-server extension's
 * gnubok_lookup_company tool (agent onboarding). One Lens call per lookup;
 * the 5-minute process cache in tic-client absorbs retries, and 404s are
 * cached too so a typo does not re-spend budget.
 */

// TIC financial summaries are Unix seconds. A missing summary means the
// company has never closed a fiscal period: the consumer's
// deriveFirstYearDefaults handles newly-registered companies from
// registrationDate instead.
export function deriveFiscalYearMonthDay(
  fin: { periodStart?: number; periodEnd?: number } | undefined,
): { startMonthDay: string | null; endMonthDay: string | null } | null {
  if (!fin?.periodStart || !fin?.periodEnd) return null
  const toMonthDay = (unixSeconds: number): string | null => {
    const d = new Date(unixSeconds * 1000)
    if (Number.isNaN(d.getTime())) return null
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(d.getUTCDate()).padStart(2, '0')
    return `${mm}-${dd}`
  }
  const startMonthDay = toMonthDay(fin.periodStart)
  const endMonthDay = toMonthDay(fin.periodEnd)
  if (!startMonthDay && !endMonthDay) return null
  return { startMonthDay, endMonthDay }
}

// The search doc's registrationDate is a Unix timestamp in seconds (same
// unit as periodStart/periodEnd above), but the app-facing contract
// (CompanyLookupResult / TICCompanyProfile) is a millisecond epoch:
// consumers feed it straight into `new Date()`. Skipping this conversion
// is how 2026 registrations rendered as "21 jan 1970" in onboarding.
export function registrationDateToMs(unixSeconds: number | null | undefined): number | null {
  if (unixSeconds == null || !Number.isFinite(unixSeconds)) return null
  return unixSeconds * 1000
}

export function mapDocumentToLookupResult(doc: TICCompanyDocument): CompanyLookupResult {
  const nameEntry =
    doc.names.find((n) => n.companyNamingType === 'name') ?? doc.names[0]
  const companyName = nameEntry?.nameOrIdentifier ?? ''

  const isCeased = doc.isCeased ?? doc.activityStatus === 'isNoLongerActive'

  const address = doc.mostRecentRegisteredAddress
    ? {
        street: doc.mostRecentRegisteredAddress.streetAddress ?? null,
        postalCode: doc.mostRecentRegisteredAddress.postalCode ?? null,
        city: doc.mostRecentRegisteredAddress.city ?? null,
      }
    : null

  const registration = {
    fTax: doc.isRegisteredForFTax ?? false,
    vat: doc.isRegisteredForVAT ?? false,
  }

  const bankAccounts = (doc.bankAccounts ?? [])
    .filter((ba) => ba.accountNumber != null && ba.bankAccountType === 'bankgiro')
    .map((ba) => ({
      type: 'bankgiro',
      accountNumber: String(ba.accountNumber),
      bic: null,
    }))

  // Search-doc shape is `{ rank, sni_2007Code, sni_2007Name, ... }`;
  // map to the canonical { code, name } the rest of the app expects.
  const sniCodes = (doc.sniCodes ?? [])
    .filter((s) => s.sni_2007Code)
    .map((s) => ({
      code: s.sni_2007Code ?? '',
      name: s.sni_2007Name ?? '',
    }))

  const email = doc.emailAddresses?.[0]?.emailAddress ?? null

  const phone =
    doc.phoneNumbers?.[0]?.phoneNumberFormatted
      ?? doc.phoneNumbers?.[0]?.e164PhoneNumber
      ?? null

  const fiscalYear = deriveFiscalYearMonthDay(doc.mostRecentFinancialSummary)

  return {
    companyName,
    isCeased,
    address,
    registration,
    bankAccounts,
    email,
    phone,
    sniCodes,
    fiscalYear,
    legalEntityType: doc.legalEntityType ?? null,
    registrationDate: registrationDateToMs(doc.registrationDate),
  }
}

/** Null means no company matched the org number (a clean "not found"). */
export async function lookupCompanyByOrgNumber(
  orgNumber: string
): Promise<CompanyLookupResult | null> {
  const doc = await searchCompanyByOrgNumber(orgNumber)
  if (!doc) return null
  return mapDocumentToLookupResult(doc)
}

/** Maximum hits the onboarding chip row shows for a name search. */
export const COMPANY_SEARCH_LIMIT = 5

/**
 * Free-text name search mapped to the same shape /lookup returns, one per
 * hit, active companies first. Empty array means nothing matched. One Lens
 * call per distinct query; a picked hit reuses its result, so the whole
 * search-and-pick flow costs the same as an org-number lookup.
 */
export async function searchCompaniesForLookup(query: string): Promise<CompanySearchHit[]> {
  const docs = await searchCompaniesByName(query, COMPANY_SEARCH_LIMIT)
  const hits: CompanySearchHit[] = []
  for (const doc of docs) {
    const orgNumber = lensRegistrationToOrgNumber(doc.registrationNumber)
    if (!orgNumber) continue
    hits.push({ orgNumber, result: mapDocumentToLookupResult(doc) })
  }
  // Stable: ceased companies sink below active ones but keep their rank.
  return [...hits.filter((h) => !h.result.isCeased), ...hits.filter((h) => h.result.isCeased)]
}

/**
 * Lens `registrationNumber` → Accounted's 10-digit org number, or null when
 * the document cannot become a valid one.
 *
 * The typed-orgnr path never stores Lens's number (it keeps what the user
 * typed), so this is the first place a Lens identifier enters settings. Lens
 * shapes: an AB is 10 digits or 16-prefixed 12; an enskild firma is 16
 * digits, the century-prefixed personnummer plus a 4-digit serial
 * (`2002011732750001` for personnummer `0201173275`, see
 * searchCompanyByOrgNumber). createCompany refuses anything normalizeOrgNumber
 * rejects, so a hit that does not reduce to a valid number is dropped here
 * rather than dead-ending the journey at submit.
 */
export function lensRegistrationToOrgNumber(registrationNumber: string): string | null {
  const digits = registrationNumber.replace(/\D/g, '')
  const candidate = /^(18|19|20)\d{14}$/.test(digits) ? digits.slice(0, 12) : digits
  const key = orgNumberKey(candidate)
  return key && normalizeOrgNumber(key) ? key : null
}
