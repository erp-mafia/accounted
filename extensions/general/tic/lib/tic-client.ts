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

// In-process TTL cache for proxy responses. Onboarding currently fires the
// same org-number lookup 2-3 times in <2 s (server prefetch + client
// useEffect + duplicate-check) and the agent build re-fetches /profile data
// minutes later. The TIC budget (3000/mo Lens calls) can't absorb the
// duplication. 5 min is long enough to collapse a full onboarding flow into
// one upstream hit and short enough that stale data never matters (TIC
// data changes on Bolagsverket filing cycles measured in days).
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX_ENTRIES = 500
interface CacheEntry {
  expiresAt: number
  value: unknown
}
const proxyCache = new Map<string, CacheEntry>()

function cacheGet<T>(key: string): T | undefined {
  const entry = proxyCache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt < Date.now()) {
    proxyCache.delete(key)
    return undefined
  }
  return entry.value as T
}

function cacheSet(key: string, value: unknown): void {
  if (proxyCache.size >= CACHE_MAX_ENTRIES) {
    // LRU-ish eviction: drop the oldest 10% so we never grow unbounded.
    const drop = Math.max(1, Math.floor(CACHE_MAX_ENTRIES / 10))
    const keys = Array.from(proxyCache.keys()).slice(0, drop)
    for (const k of keys) proxyCache.delete(k)
  }
  proxyCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value })
}

// Test-only: flush the in-process cache so per-test fixtures don't bleed
// across cases. Not used by production code.
export function __resetTicCacheForTest(): void {
  proxyCache.clear()
}

/**
 * Generic TIC API fetch helper.
 *
 * Routes through the proxy at TIC_API_PROXY_URL (no API key needed in this
 * codebase). The proxy targets `lens-api.tic.io` (v2 "Lens API") and adds
 * `x-api-key` server-side. v1 (`api.tic.io`) is retired: all paths below
 * are Lens paths (no `/datasets/` prefix, `id` instead of `companyId`).
 */
export async function ticApiFetch<T>(endpoint: string): Promise<T | null> {
  const proxyUrl = process.env.TIC_API_PROXY_URL
  if (!proxyUrl) {
    throw new TICAPIError('TIC_API_PROXY_URL is not configured', undefined, 'NOT_CONFIGURED')
  }

  // Check the in-process cache first. The cache key is the endpoint (which
  // includes the org-number / company-id) so each unique upstream call is
  // memoized; 404 responses are cached as `null` deliberately so a typo'd
  // org-number doesn't re-spend a call on every keystroke.
  const cached = cacheGet<T | null>(endpoint)
  if (cached !== undefined) {
    return cached
  }

  const url = `${proxyUrl}?endpoint=${encodeURIComponent(endpoint)}`

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIC_API_TIMEOUT),
    })

    if (response.status === 404) {
      cacheSet(endpoint, null)
      return null
    }

    if (response.status === 429) {
      // Do NOT cache rate-limit responses: the next call after the window
      // resets should be allowed through.
      throw new TICAPIError('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED')
    }

    if (!response.ok) {
      throw new TICAPIError(`TIC API error: ${response.statusText}`, response.status)
    }

    const body = await response.json()
    cacheSet(endpoint, body)
    return body
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

/**
 * Expand a 10-digit personnummer to the 12-digit (century-prefixed) form that
 * Lens requires to resolve an enskild firma. Lens stores a sole trader under a
 * 16-digit registration number derived from the 12-digit personnummer; the bare
 * 10-digit form only ever fuzzy-matches, which is how a personnummer once
 * resolved to an unrelated foundation.
 *
 * Detection is unambiguous: a Swedish organisationsnummer always has a 3rd digit
 * >= 2, whereas a personnummer's 3rd+4th digits are the birth month (01-12). So
 * a 10-digit number whose 3rd digit is 0/1 and whose month reads 01-12 is a
 * personnummer and gets the century prefix; AB / förening / handelsbolag numbers
 * pass through untouched. Century (19 vs 20) uses the same heuristic as
 * `formatRedovisare`: a two-digit year greater than the current one is 1900s.
 */
function toLensQueryNumber(cleaned: string): string {
  if (!/^\d{10}$/.test(cleaned)) return cleaned
  const month = parseInt(cleaned.substring(2, 4), 10)
  const isPersonnummer = cleaned[2] <= '1' && month >= 1 && month <= 12
  if (!isPersonnummer) return cleaned
  const yearDigits = parseInt(cleaned.substring(0, 2), 10)
  const currentTwoDigitYear = new Date().getFullYear() % 100
  const prefix = yearDigits > currentTwoDigitYear ? '19' : '20'
  return `${prefix}${cleaned}`
}

/**
 * Search for a company by org number. Returns the matching document or null.
 *
 * TIC v2 is a Typesense index and `query_by=registrationNumber` is a
 * typo-tolerant full-text search: it returns ranked *near-misses*, not only
 * exact hits. An identifier that isn't in the index therefore comes back as
 * the closest lookalike number: a completely unrelated entity (this is how
 * an enskild firma's personnummer once resolved to a random foundation).
 *
 * We validate the returned `registrationNumber` against the requested number
 * before accepting a hit. The check is *containment*, not strict equality,
 * because Lens stores an enskild firma under a 16-digit registration number
 * that embeds the 10-digit personnummer (e.g. request `0201173275` →
 * Lens `2002011732750001`). Requiring exact equality would wrongly reject
 * every correctly-resolved sole trader. A genuine mismatch (Björn's case)
 * has neither number containing the other, so it is still discarded and the
 * caller sees a clean "not found" instead of a stranger's company.
 *
 * The upstream request is intentionally unchanged: the fuzzy `q=` call is
 * what every working lookup already uses; we only tighten which hit we accept.
 */
export async function searchCompanyByOrgNumber(
  orgNumber: string
): Promise<TICCompanyDocument | null> {
  const cleaned = orgNumber.replace(/[\s-]/g, '')
  const data = await ticApiFetch<TICCompanyResponse>(
    `/search-public/companies?q=${toLensQueryNumber(cleaned)}&query_by=registrationNumber`
  )

  if (!data || data.found === 0 || !data.hits?.length) {
    return null
  }

  // A real match either equals the requested number or embeds it (16-digit
  // enskild-firma number containing the 10-digit personnummer). Guard the
  // containment branch with a length floor so a short/garbage query can't
  // coincidentally substring-match an unrelated number: all real Swedish
  // identifiers are >= 10 digits.
  const numbersRelated = (returned: string): boolean => {
    if (returned === cleaned) return true
    if (cleaned.length < 10 || returned.length < 10) return false
    return returned.includes(cleaned) || cleaned.includes(returned)
  }

  const match = data.hits.find((hit) => {
    const returned = hit.document?.registrationNumber?.replace(/[\s-]/g, '') ?? ''
    return returned.length > 0 && numbersRelated(returned)
  })

  return match?.document ?? null
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
 * equivalent: used to auto-fill fiscal-year selection during Accounted
 * onboarding so the user doesn't have to enter MM-DD manually.
 */
export async function getFiscalYears(companyId: number): Promise<TICFiscalYear[] | null> {
  return ticApiFetch<TICFiscalYear[]>(`/companies/${companyId}/fiscal-years`)
}

/**
 * Get accounting-period change history for a company. v2 endpoint with
 * no v1 equivalent: surfaces "this company has shifted its year-end"
 * during onboarding/customer-setup.
 */
export async function getAccountingPeriods(
  companyId: number
): Promise<TICAccountingPeriod[] | null> {
  return ticApiFetch<TICAccountingPeriod[]>(`/companies/${companyId}/accounting-periods`)
}

/**
 * Get payroll summary for a company. v2 endpoint: restructured from
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
 * v2 endpoint: split out from what v1 grouped under `/parties`.
 * Representatives (board/CEO/auditor) live at `/representatives` instead.
 */
export async function getBeneficialOwners(
  companyId: number,
): Promise<TICBeneficialOwnerResponse | null> {
  return ticApiFetch<TICBeneficialOwnerResponse>(
    `/companies/${companyId}/beneficial-owners`,
  )
}
