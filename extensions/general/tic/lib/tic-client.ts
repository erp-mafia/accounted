import type {
  TICCompanyResponse,
  TICCompanyDocument,
  TICBankAccount,
  TICSNICode,
  TICEmail,
  TICPhone,
  TICCompanyPurpose,
  TICFinancialReportSummary,
  TICBeneficialOwnerResponse,
} from './tic-types'
import { TICAPIError } from './tic-types'

const TIC_API_TIMEOUT = 15_000

/**
 * Generic TIC API fetch helper.
 * Routes through the proxy at TIC_API_PROXY_URL (no API key needed).
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
    `/search/companies?q=${cleaned}&query_by=registrationNumber`
  )

  if (!data || data.found === 0 || !data.hits?.[0]) {
    return null
  }

  return data.hits[0].document
}

/** Get bank accounts for a company. */
export async function getBankAccounts(companyId: number): Promise<TICBankAccount[] | null> {
  return ticApiFetch<TICBankAccount[]>(`/datasets/companies/${companyId}/bank-accounts`)
}

/** Get SNI codes for a company. */
export async function getSNICodes(companyId: number): Promise<TICSNICode[] | null> {
  return ticApiFetch<TICSNICode[]>(`/datasets/companies/${companyId}/se/sni`)
}

/** Get email addresses for a company. */
export async function getEmails(companyId: number): Promise<TICEmail[] | null> {
  return ticApiFetch<TICEmail[]>(`/datasets/companies/${companyId}/email-addresses`)
}

/** Get phone numbers for a company. */
export async function getPhones(companyId: number): Promise<TICPhone[] | null> {
  return ticApiFetch<TICPhone[]>(`/datasets/companies/${companyId}/phone-numbers`)
}

/** Get company purpose / verksamhetsbeskrivning. */
export async function getCompanyPurpose(companyId: number): Promise<TICCompanyPurpose[] | null> {
  return ticApiFetch<TICCompanyPurpose[]>(`/datasets/companies/${companyId}/purpose`)
}

/** Get financial report summaries for a company. */
export async function getFinancialReportSummaries(companyId: number): Promise<TICFinancialReportSummary[] | null> {
  return ticApiFetch<TICFinancialReportSummary[]>(`/datasets/companies/${companyId}/financial-report-summaries`)
}

/** Get current + historic beneficial owner records from Bolagsverket
 * (verklig huvudman per Lag 2017:631). Returns notifications and any
 * exempt-from-registration flags. Used to answer ownership questions
 * authoritatively rather than asking the user to confirm. */
export async function getBeneficialOwners(companyId: number): Promise<TICBeneficialOwnerResponse | null> {
  return ticApiFetch<TICBeneficialOwnerResponse>(
    `/datasets/companies/${companyId}/se/beneficial-owners`,
  )
}
