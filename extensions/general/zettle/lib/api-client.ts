/**
 * Minimal Zettle Purchase API client for the paid-purchase feed.
 *
 * Host is fixed (purchase.izettle.com), not tenant input, so SSRF guarding
 * via safeFetch is unnecessary; fetchWithTimeout covers hung connections.
 * Auth is a short-lived Bearer access token obtained by refreshing the
 * stored refresh token at the start of each run.
 */

import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout'
import { sleep } from '@/lib/utils'
import type { ZettlePurchase } from '../types'

const PURCHASE_BASE = 'https://purchase.izettle.com'
export const ZETTLE_PAGE_SIZE = 100
const REQUEST_TIMEOUT_MS = 30_000
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const RETRY_DELAYS_MS = [1_000, 3_000]

export class ZettleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'ZettleApiError'
  }
}

/** Whether an API error means the credentials themselves are dead. */
export function isRevokedCredentialsError(error: unknown): boolean {
  if (!(error instanceof ZettleApiError)) return false
  return error.status === 401 || error.status === 403
}

export interface PurchasesPage {
  purchases: ZettlePurchase[]
  lastPurchaseHash: string | null
  hasMore: boolean
}

export interface ListPurchasesOptions {
  /** Inclusive UTC start (ISO date or datetime). */
  startDate: string
  /** Hash from the previous page's lastPurchaseHash, or null for page one. */
  lastPurchaseHash: string | null
}

async function getJson(url: string, accessToken: string): Promise<Response> {
  return fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    },
    { timeoutMs: REQUEST_TIMEOUT_MS, description: 'Zettle Purchase API' },
  )
}

/**
 * One page of purchases on/after startDate, oldest first so the caller's
 * cursor advances chronologically. Pagination uses lastPurchaseHash.
 */
export async function listPurchasesPage(
  accessToken: string,
  options: ListPurchasesOptions,
): Promise<PurchasesPage> {
  const params = new URLSearchParams({
    startDate: options.startDate,
    limit: String(ZETTLE_PAGE_SIZE),
    descending: 'false',
  })
  if (options.lastPurchaseHash) {
    params.set('lastPurchaseHash', options.lastPurchaseHash)
  }
  const url = `${PURCHASE_BASE}/purchases/v2?${params.toString()}`

  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let response: Response
    try {
      response = await getJson(url, accessToken)
    } catch (err) {
      lastError = new ZettleApiError(
        `Zettle request failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
      )
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw lastError
    }

    if (!response.ok) {
      if (RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        lastError = new ZettleApiError(`Zettle API ${response.status}`, response.status)
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw new ZettleApiError(`Zettle API ${response.status}`, response.status)
    }

    const body = (await response.json().catch(() => null)) as {
      purchases?: ZettlePurchase[]
      lastPurchaseHash?: string | null
    } | null

    const purchases = Array.isArray(body?.purchases) ? body!.purchases! : []
    const lastPurchaseHash =
      typeof body?.lastPurchaseHash === 'string' && body.lastPurchaseHash
        ? body.lastPurchaseHash
        : null
    return {
      purchases,
      lastPurchaseHash,
      // Another page exists when this page was full and a hash was returned.
      hasMore: purchases.length >= ZETTLE_PAGE_SIZE && lastPurchaseHash !== null,
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ZettleApiError('Zettle request failed', 0)
}
