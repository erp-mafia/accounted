import { sleep } from '@/lib/utils'
import type { WooOrder, WooRefund, WooStoreInfo } from '../types'

/**
 * Minimal WooCommerce REST API (wc/v3) client for the order feed.
 *
 * Auth is HTTP Basic (consumer key as username, secret as password) over
 * HTTPS only. Some hosts (Apache CGI, security plugins) strip the
 * Authorization header, so a 401 is retried once with the documented
 * query-string credential fallback; that fallback is why plain-http stores
 * are refused outright (keys in a cleartext URL are a credentials leak).
 *
 * Typical WooCommerce hosts are slow shared PHP boxes: requests run
 * sequentially, pages are capped at 100 rows, and 429/5xx responses get a
 * short exponential backoff before the error is surfaced.
 */

const REQUEST_TIMEOUT_MS = 30_000
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const RETRY_DELAYS_MS = [1_000, 3_000]
/** wc/v3 hard maximum for per_page. */
export const WC_PAGE_SIZE = 100

export interface WooCredentials {
  storeUrl: string
  consumerKey: string
  consumerSecret: string
}

export class WooCommerceApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for network-level failures. */
    readonly status: number,
    /** WooCommerce error code (e.g. woocommerce_rest_cannot_view), if any. */
    readonly wooCode: string | null = null,
  ) {
    super(message)
    this.name = 'WooCommerceApiError'
  }
}

/**
 * Whether an API error means the credentials themselves are dead (key deleted
 * or demoted in wp-admin), as opposed to a transient failure. Used to flip a
 * connection to status 'revoked' so the UI offers a reconnect instead of the
 * cron retrying forever.
 */
export function isRevokedCredentialsError(error: unknown): boolean {
  if (!(error instanceof WooCommerceApiError)) return false
  return error.status === 401 || error.status === 403
}

/**
 * Hostnames the server must never fetch: the store URL is user input that we
 * probe server-side, so loopback/link-local/private ranges and internal
 * naming conventions are refused outright (SSRF guard). Hostname-level only:
 * a public DNS name resolving to a private address is not caught here, which
 * matches the app's other outbound-URL surfaces.
 */
function isDisallowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  // IPv6 literals (URL.hostname strips the brackets): never a real store.
  if (h.includes(':')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  return false
}

/**
 * Normalize and validate a user-entered store URL to an https origin plus
 * optional subdirectory path (WordPress installs under a path are common),
 * lowercased host, no trailing slash, no query/fragment/credentials, and no
 * private/internal hosts. Returns null for anything invalid, including
 * plain http.
 */
export function normalizeStoreUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.search || url.hash) return null
  if (isDisallowedHost(url.hostname)) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `https://${url.host.toLowerCase()}${path}`
}

function buildUrl(
  creds: WooCredentials,
  path: string,
  params: Record<string, string>,
  credentialsInQuery: boolean,
): string {
  const url = new URL(`${creds.storeUrl}/wp-json/wc/v3${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  if (credentialsInQuery) {
    url.searchParams.set('consumer_key', creds.consumerKey)
    url.searchParams.set('consumer_secret', creds.consumerSecret)
  }
  return url.toString()
}

async function requestOnce(
  creds: WooCredentials,
  path: string,
  params: Record<string, string>,
  credentialsInQuery: boolean,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (!credentialsInQuery) {
    const basic = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64')
    headers.Authorization = `Basic ${basic}`
  }
  return fetch(buildUrl(creds, path, params, credentialsInQuery), {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

async function parseError(response: Response): Promise<WooCommerceApiError> {
  let wooCode: string | null = null
  let detail = ''
  try {
    const body = (await response.json()) as { code?: string; message?: string }
    wooCode = body.code ?? null
    detail = body.message ?? ''
  } catch {
    // Non-JSON error body (host error page); the status is enough.
  }
  return new WooCommerceApiError(
    `WooCommerce API ${response.status}${detail ? `: ${detail}` : ''}`,
    response.status,
    wooCode,
  )
}

/**
 * GET a wc/v3 path. Retries the header-stripped-auth case (401 → query-string
 * credentials) once, and 429/5xx with a short backoff.
 */
export async function wcGet<T>(
  creds: WooCredentials,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  let credentialsInQuery = false
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let response: Response
    try {
      response = await requestOnce(creds, path, params, credentialsInQuery)
    } catch (err) {
      // Network/timeout errors: retry on the same backoff schedule.
      lastError = new WooCommerceApiError(
        `WooCommerce request failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
      )
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw lastError
    }

    if (response.ok) return (await response.json()) as T

    if (response.status === 401 && !credentialsInQuery) {
      // Host may be stripping the Authorization header; the documented
      // fallback is credentials in the query string (HTTPS enforced upstream).
      credentialsInQuery = true
      lastError = await parseError(response)
      continue
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      lastError = await parseError(response)
      await sleep(RETRY_DELAYS_MS[attempt])
      continue
    }
    throw await parseError(response)
  }
  throw lastError instanceof Error
    ? lastError
    : new WooCommerceApiError('WooCommerce request failed', 0)
}

export interface ListOrdersOptions {
  /** ISO timestamp; interpreted as UTC (dates_are_gmt is always sent). */
  modifiedAfter: string
  page: number
}

/**
 * One page of orders modified after the cursor, oldest-modified first so the
 * caller's cursor advances chronologically. Requires WooCommerce 5.8+
 * (modified_after); older stores fail with a woocommerce_rest_invalid_param
 * style error surfaced to the connection's error state.
 */
export async function listOrdersPage(
  creds: WooCredentials,
  options: ListOrdersOptions,
): Promise<WooOrder[]> {
  return wcGet<WooOrder[]>(creds, '/orders', {
    modified_after: options.modifiedAfter,
    dates_are_gmt: 'true',
    status: 'any',
    orderby: 'modified',
    order: 'asc',
    per_page: String(WC_PAGE_SIZE),
    page: String(options.page),
  })
}

/** Hard cap on refund pages per order; a real order never approaches this. */
const MAX_REFUND_PAGES = 10

/**
 * All refunds of one order. Terminates on an EMPTY batch, not a short one
 * (hosts may cap per_page below our request, same as the order pagination),
 * dedupes by id so a host that ignores `page` cannot loop forever, and caps
 * total pages as a final backstop.
 */
export async function listOrderRefunds(
  creds: WooCredentials,
  orderId: number,
): Promise<WooRefund[]> {
  const refunds: WooRefund[] = []
  const seen = new Set<number>()
  for (let page = 1; page <= MAX_REFUND_PAGES; page++) {
    const batch = await wcGet<WooRefund[]>(creds, `/orders/${orderId}/refunds`, {
      per_page: String(WC_PAGE_SIZE),
      page: String(page),
    })
    if (batch.length === 0) return refunds
    const fresh = batch.filter((r) => !seen.has(r.id))
    if (fresh.length === 0) return refunds
    for (const refund of fresh) seen.add(refund.id)
    refunds.push(...fresh)
  }
  // Cap exhausted with data still flowing: returning the partial list would
  // let the sync advance its cursor past refunds it never saw. Throwing
  // routes into the caller's refund-failure path instead (order held, cursor
  // capped, retried next run).
  throw new WooCommerceApiError(
    `Refund pagination cap exceeded for order ${orderId}`,
    0,
  )
}

/**
 * Verify credentials and read store metadata. The one-order probe is the
 * authoritative credential check (it exercises the read scope the feed
 * needs); title and settings lookups are best-effort extras.
 */
export async function testConnectionAndFetchStoreInfo(
  creds: WooCredentials,
): Promise<WooStoreInfo> {
  await wcGet<unknown[]>(creds, '/orders', { per_page: '1' })

  const info: WooStoreInfo = {
    name: null,
    currency: null,
    prices_include_tax: null,
    wc_version: null,
  }

  try {
    const settings = await wcGet<Array<{ id: string; value: unknown }>>(
      creds,
      '/settings/general',
    )
    const currency = settings.find((s) => s.id === 'woocommerce_currency')?.value
    if (typeof currency === 'string' && currency) info.currency = currency.toUpperCase()
    const pricesIncludeTax = settings.find((s) => s.id === 'woocommerce_prices_include_tax')?.value
    if (typeof pricesIncludeTax === 'string') info.prices_include_tax = pricesIncludeTax === 'yes'
  } catch {
    // Settings need broader permissions on some setups; the feed works without.
  }

  try {
    const status = await wcGet<{ environment?: { version?: string } }>(creds, '/system_status')
    if (status.environment?.version) info.wc_version = status.environment.version
  } catch {
    // system_status is admin-capability data and often blocked; optional.
  }

  try {
    // The WP REST index is public and carries the site title.
    const response = await fetch(`${creds.storeUrl}/wp-json/`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.ok) {
      const body = (await response.json()) as { name?: string }
      if (body.name) info.name = body.name
    }
  } catch {
    // Cosmetic only.
  }

  return info
}
