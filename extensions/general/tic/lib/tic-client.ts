import type {
  TICCompanyResponse,
  TICCompanyDocument,
  TICBankgirot,
  TICIndustryCode,
  TICEmail,
  TICPhone,
  TICCompanyPurpose,
  TICDocument,
  TICFiscalYear,
  TICAccountingPeriod,
  TICPayrollSummary,
  TICSignatory,
  TICRepresentatives,
  TICCompanyStatusEntry,
  TICBeneficialOwnerResponse,
} from './tic-types'
import { TICAPIError } from './tic-types'

const TIC_API_TIMEOUT = 15_000

/**
 * Generic TIC API fetch helper.
 *
 * Routes through the proxy at TIC_API_PROXY_URL (no API key needed in this
 * codebase). The proxy targets `lens-api.tic.io` (v2 "Lens API") and adds
 * `x-api-key` server-side. v1 (`api.tic.io`) is retired — all paths below
 * are Lens paths (no `/datasets/` prefix, `id` instead of `companyId`).
 */
export async function ticApiFetch<T>(endpoint: string): Promise<T | null> {
  const proxyUrl = process.env.TIC_API_PROXY_URL
  if (!proxyUrl) {
    throw new TICAPIError('TIC_API_PROXY_URL is not configured', undefined, 'NOT_CONFIGURED')
  }

  const url = `${proxyUrl}?endpoint=${encodeURIComponent(endpoint)}`

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIC_API_TIMEOUT),
    })

    if (response.status === 404) {
      return null
    }

    if (response.status === 429) {
      throw new TICAPIError('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED')
    }

    if (!response.ok) {
      throw new TICAPIError(`TIC API error: ${response.statusText}`, response.status)
    }

    return await response.json()
  } catch (error: unknown) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new TICAPIError('Request timeout', undefined, 'TIMEOUT')
    }
    if (error instanceof TICAPIError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new TICAPIError(`Failed to fetch from TIC: ${message}`)
  }
}

/** Search for a company by org number. Returns the first matching document or null. */
export async function searchCompanyByOrgNumber(
  orgNumber: string
): Promise<TICCompanyDocument | null> {
  const cleaned = orgNumber.replace(/[\s-]/g, '')
  const data = await ticApiFetch<TICCompanyResponse>(
    `/search-public/companies?q=${cleaned}&query_by=registrationNumber`
  )

  if (!data || data.found === 0 || !data.hits?.[0]) {
    return null
  }

  return data.hits[0].document
}

/**
 * Get bank accounts for a company. v2 narrows this endpoint to Bankgirot
 * numbers only (returns `Bankgironumber_Dto[]`); v1's IBAN / plusgiro
 * coverage is no longer available from this path.
 */
export async function getBankAccounts(companyId: number): Promise<TICBankgirot[] | null> {
  return ticApiFetch<TICBankgirot[]>(`/companies/${companyId}/bank-accounts`)
}

/**
 * Get industry codes for a company. v2 returns a discriminated array
 * (`CompanyIndustryCode_Dto[]`) covering both SNI 2007 and SNI 2025;
 * callers filter by `companyIndustryCodeType` for the version they want.
 */
export async function getIndustryCodes(companyId: number): Promise<TICIndustryCode[] | null> {
  return ticApiFetch<TICIndustryCode[]>(`/companies/${companyId}/industries`)
}

/** Get email addresses for a company. */
export async function getEmails(companyId: number): Promise<TICEmail[] | null> {
  return ticApiFetch<TICEmail[]>(`/companies/${companyId}/email-addresses`)
}

/** Get phone numbers for a company. */
export async function getPhones(companyId: number): Promise<TICPhone[] | null> {
  return ticApiFetch<TICPhone[]>(`/companies/${companyId}/phone-numbers`)
}

/** Get company purpose / verksamhetsbeskrivning. */
export async function getCompanyPurpose(companyId: number): Promise<TICCompanyPurpose[] | null> {
  return ticApiFetch<TICCompanyPurpose[]>(`/companies/${companyId}/purposes`)
}

/**
 * List all documents filed by the company (annual reports, audit reports,
 * articles of association, minutes, etc.). v2 replaces v1's
 * `/financial-report-summaries` with this broader endpoint. Filter the
 * result by `type === 'annualReport'` to recover the financial-report
 * subset.
 */
export async function getCompanyDocuments(companyId: number): Promise<TICDocument[] | null> {
  return ticApiFetch<TICDocument[]>(`/companies/${companyId}/documents`)
}

/**
 * Get fiscal-year configurations for a company. v2 endpoint with no v1
 * equivalent — used to auto-fill fiscal-year selection during gnubok
 * onboarding so the user doesn't have to enter MM-DD manually.
 */
export async function getFiscalYears(companyId: number): Promise<TICFiscalYear[] | null> {
  return ticApiFetch<TICFiscalYear[]>(`/companies/${companyId}/fiscal-years`)
}

/**
 * Get accounting-period change history for a company. v2 endpoint with
 * no v1 equivalent — surfaces "this company has shifted its year-end"
 * during onboarding/customer-setup.
 */
export async function getAccountingPeriods(
  companyId: number
): Promise<TICAccountingPeriod[] | null> {
  return ticApiFetch<TICAccountingPeriod[]>(`/companies/${companyId}/accounting-periods`)
}

/**
 * Get payroll summary for a company. v2 endpoint — restructured from
 * v1's `/se/payroll`, returns `{ payroll2, payrolls }` where `payroll2`
 * is the modern per-period breakdown and `payrolls` is the legacy
 * Skatteverket MOMS/AG totals.
 */
export async function getPayrolls(companyId: number): Promise<TICPayrollSummary | null> {
  return ticApiFetch<TICPayrollSummary>(`/companies/${companyId}/payrolls`)
}

/**
 * Get firmateckning (signatory) rules for a company. v2 endpoint
 * (renamed from v1 `/signatories`). Free-form Swedish descriptions of
 * who can sign for the company; consumed by the AB invoice/årsredovisning
 * signer-pick flows.
 */
export async function getSignatory(companyId: number): Promise<TICSignatory[] | null> {
  return ticApiFetch<TICSignatory[]>(`/companies/${companyId}/signatory`)
}

/**
 * Get representatives (board / CEO / auditor) for a company. v2 splits
 * what v1 called `/parties` into `/representatives` (this endpoint) and
 * `/beneficial-owners` (separate). Returns a wrapper with board-summary
 * counts plus the per-person list.
 */
export async function getRepresentatives(
  companyId: number
): Promise<TICRepresentatives | null> {
  return ticApiFetch<TICRepresentatives>(`/companies/${companyId}/representatives`)
}

/**
 * Get current and historical status entries for a company (active, in
 * liquidation, struck off, bankruptcy, etc.). v2 endpoint. Each entry
 * carries a traffic-light `statusColor` (red/yellow/green/neutral) and
 * an `isCeased` flag inside `companyStatusDescription`.
 */
export async function getCompanyStatus(
  companyId: number
): Promise<TICCompanyStatusEntry[] | null> {
  return ticApiFetch<TICCompanyStatusEntry[]>(`/companies/${companyId}/status`)
}

/**
 * Get current + historic beneficial owner records from Bolagsverket
 * (verklig huvudman per Lag 2017:631). Returns notifications and any
 * exempt-from-registration flags. Used to answer ownership questions
 * authoritatively rather than asking the user to confirm.
 *
 * v2 endpoint — split out from what v1 grouped under `/parties`.
 * Representatives (board/CEO/auditor) live at `/representatives` instead.
 */
export async function getBeneficialOwners(
  companyId: number,
): Promise<TICBeneficialOwnerResponse | null> {
  return ticApiFetch<TICBeneficialOwnerResponse>(
    `/companies/${companyId}/beneficial-owners`,
  )
}
