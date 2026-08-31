import { searchCompanyByOrgNumber } from './tic-client'
import type { TICCompanyDocument } from './tic-types'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'

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
