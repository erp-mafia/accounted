/**
 * HTTP client for the Arcim Sync gateway API.
 *
 * Targets the consent-based resource API (/api/v1/consents/...) which
 * provides typed, normalized access to any Swedish accounting provider.
 */

import type {
  ArcimProvider,
  ConsentRecord,
  PaginatedResponse,
  CompanyInformationDto,
  CustomerDto,
} from '../types'

function getBaseUrl(): string {
  const url = process.env.ARCIM_SYNC_GATEWAY_URL
  if (!url) throw new Error('ARCIM_SYNC_GATEWAY_URL is not configured')
  return url.replace(/\/$/, '')
}

function getApiKey(): string {
  const key = process.env.ARCIM_SYNC_API_KEY
  if (!key) throw new Error('ARCIM_SYNC_API_KEY is not configured')
  return key
}

const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1_000
const RETRYABLE_STATUSES = [429, 502, 503, 504]

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs: number = 120_000
): Promise<T> {
  const url = `${getBaseUrl()}${path}`

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${getApiKey()}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      })
    } catch (err) {
      const isAbort = err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')
      if (attempt < MAX_RETRIES && isAbort) {
        console.warn(`[arcim] ${path} timed out, retrying (attempt ${attempt + 1})`)
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)))
        continue
      }
      if (isAbort) {
        throw new Error(`Arcim API timeout after ${Math.round(timeoutMs / 1000)}s: ${path}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }

    if (attempt < MAX_RETRIES && RETRYABLE_STATUSES.includes(response.status)) {
      console.warn(`[arcim] ${path} returned ${response.status}, retrying (attempt ${attempt + 1})`)
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)))
      continue
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Arcim API ${response.status}: ${body || response.statusText}`)
    }

    return response.json()
  }

  throw new Error(`Arcim API failed after ${MAX_RETRIES + 1} attempts: ${path}`)
}

// ── Consent lifecycle ───────────────────────────────────────────────

export async function createConsent(
  provider: ArcimProvider,
  name: string,
  orgNumber?: string,
  companyName?: string
): Promise<ConsentRecord> {
  return request<ConsentRecord>('/api/v1/consents', {
    method: 'POST',
    body: JSON.stringify({ name, provider, orgNumber, companyName }),
  })
}

export async function getConsent(consentId: string): Promise<ConsentRecord> {
  return request<ConsentRecord>(`/api/v1/consents/${consentId}`)
}

// ── Resource fetching (paginated) ───────────────────────────────────

async function fetchAllPages<T>(
  consentId: string,
  resource: string,
  params?: Record<string, string>,
  pageSize: number = 100,
  maxPages: number = 500
): Promise<T[]> {
  const all: T[] = []
  let page = 1

  while (page <= maxPages) {
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      ...params,
    })
    const result = await request<PaginatedResponse<T>>(
      `/api/v1/consents/${consentId}/${resource}?${query}`
    )
    all.push(...result.data)

    if (!result.hasMore || result.data.length === 0) break
    page++
  }

  return all
}

// ── Typed resource accessors ────────────────────────────────────────

export async function fetchCompanyInfo(
  consentId: string
): Promise<CompanyInformationDto | null> {
  // CompanyInformation is a singleton resource: gateway returns { data: object }
  const result = await request<{ data: CompanyInformationDto }>(
    `/api/v1/consents/${consentId}/companyinformation`
  )
  return result.data ?? null
}

export async function fetchCustomers(consentId: string): Promise<CustomerDto[]> {
  return fetchAllPages<CustomerDto>(consentId, 'customers')
}

// The gateway SIE export path (fetchSIEExport/SIEExportFile) was deliberately
// removed: it returned SIE as a pre-decoded string, and the gateway's decode of
// CP437 bytes as windows-1252 caused the 2026-03-17 mojibake incident. Provider
// SIE now travels as raw bytes through lib/sie-fetcher.ts and the repo's own
// encoding detection. Do not re-add a string-typed SIE fetch here.
