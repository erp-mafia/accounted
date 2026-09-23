/**
 * TIC Identity API client for BankID authentication.
 *
 * Direct calls to https://id.tic.io/api/v1/ with X-Api-Key header.
 * This is a separate API surface from the company lookup proxy (TIC_API_PROXY_URL).
 */

import { TICAPIError } from './tic-types'
import type {
  BankIdStartRequest,
  BankIdStartResponse,
  BankIdPollResponse,
  BankIdCollectResponse,
  EnrichmentRequest,
  EnrichmentResponse,
  EnrichmentData,
} from './bankid-types'

const API_TIMEOUT = 15_000

function getConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.TIC_IDENTITY_API_URL || 'https://id.tic.io/api/v1'
  const apiKey = process.env.TIC_IDENTITY_API_KEY
  if (!apiKey) {
    throw new TICAPIError('TIC_IDENTITY_API_KEY is not configured', undefined, 'NOT_CONFIGURED')
  }
  return { baseUrl, apiKey }
}

async function identityFetch<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const { baseUrl, apiKey } = getConfig()
  const url = `${baseUrl}${path}`

  const headers: Record<string, string> = {
    'X-Api-Key': apiKey,
    'Accept': 'application/json',
  }
  if (body) {
    headers['Content-Type'] = 'application/json'
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(API_TIMEOUT),
    })

    if (response.status === 429) {
      throw new TICAPIError('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED')
    }

    if (response.status === 410) {
      // Session failed/expired: return the error body
      const data = await response.json()
      return data as T
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => response.statusText)
      throw new TICAPIError(`TIC Identity API error: ${errorBody}`, response.status)
    }

    // DELETE returns no body
    if (response.status === 204 || method === 'DELETE') {
      return undefined as T
    }

    return await response.json()
  } catch (error: unknown) {
    if (error instanceof TICAPIError) throw error
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new TICAPIError('Request timeout', undefined, 'TIMEOUT')
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new TICAPIError(`TIC Identity API request failed: ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Start a new BankID authentication session. */
export async function startBankIdAuth(
  endUserIp: string,
  userAgent?: string
): Promise<BankIdStartResponse> {
  const body: BankIdStartRequest = { endUserIp }
  if (userAgent) body.userAgent = userAgent

  return identityFetch<BankIdStartResponse>('POST', '/auth/bankid/start', body)
}

/** Poll a BankID session for status updates. Call every 2 seconds. */
export async function pollBankIdSession(sessionId: string): Promise<BankIdPollResponse> {
  return identityFetch<BankIdPollResponse>('POST', `/auth/${sessionId}/poll`)
}

/** Fetch cached session data (after webhook/callback, not for polling). */
export async function collectBankIdResult(sessionId: string): Promise<BankIdCollectResponse> {
  return identityFetch<BankIdCollectResponse>('GET', `/auth/${sessionId}/collect`)
}

/** Cancel an active BankID session. */
export async function cancelBankIdSession(sessionId: string): Promise<void> {
  return identityFetch<void>('DELETE', `/auth/${sessionId}`)
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/** Request enrichment data for a completed session. Must be called within 30 min. */
export async function requestEnrichment(
  sessionId: string,
  types: EnrichmentRequest['types']
): Promise<EnrichmentResponse> {
  const body: EnrichmentRequest = { sessionId, types }
  return identityFetch<EnrichmentResponse>('POST', '/enrichment', body)
}

/** Fetch enrichment data from the one-time secure URL. No API key needed for this call. */
export async function fetchEnrichmentData(secureUrl: string): Promise<EnrichmentData> {
  const { baseUrl } = getConfig()
  // secureUrl is a relative path like /api/v1/enrichment/data/{token}
  const url = secureUrl.startsWith('http') ? secureUrl : `${baseUrl.replace('/api/v1', '')}${secureUrl}`

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT),
  })

  if (response.status === 410) {
    throw new TICAPIError('Enrichment data expired or already fetched', 410, 'TOKEN_EXPIRED')
  }

  if (!response.ok) {
    throw new TICAPIError(`Failed to fetch enrichment data: ${response.statusText}`, response.status)
  }

  return await response.json()
}
