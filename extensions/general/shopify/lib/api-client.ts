import { isUnsafeUrlError, safeFetch } from '@/lib/http/safe-fetch'
import type { ShopifyOrder, ShopifyShopInfo } from '../types'

/**
 * Minimal Shopify GraphQL Admin API client for the order feed.
 *
 * The shop domain is tenant input that the server connects to, and members
 * can write `shopify_connections.shop_domain` directly through PostgREST
 * (bypassing the connect route's normalisation), so every request here
 * re-normalises the stored domain to `<handle>.myshopify.com` and goes
 * through `safeFetch`: public addresses only, checked at request time, and no
 * redirects followed.
 *
 * Auth is the client credentials grant: the merchant creates a custom app in
 * their own Shopify Dev Dashboard (the admin-created custom apps with
 * revealable shpat_ tokens were discontinued 2026-01-01) and pastes the app's
 * client id/secret; the server exchanges those for a ~24h access token at the
 * start of every run. REST is legacy since 2024, so everything here is
 * GraphQL against a pinned API version.
 *
 * Rate limiting is cost-based (points/second leaky bucket); a throttled query
 * comes back as HTTP 200 with a THROTTLED GraphQL error, so both that and
 * plain 429/5xx get a short backoff before the error is surfaced.
 */

/** Pinned Admin API version; bump quarterly (supported >= 12 months). */
export const SHOPIFY_API_VERSION = '2026-07'
/**
 * Orders per page. The API caps `first` at 250, but query cost is what binds
 * here: each order carries nested lineItems/shippingLines connections, and a
 * single GraphQL query must stay under the 1000-point ceiling
 * (25 * (~1 + lineItems 25 + shipping 5 + overhead) lands well below it).
 */
export const SHOPIFY_PAGE_SIZE = 25
/** Line items fetched per order; more than this drops the line snapshot. */
export const SHOPIFY_LINE_ITEMS_PAGE = 25
/** Shipping lines fetched per order; >5 on one order is effectively unheard of. */
export const SHOPIFY_SHIPPING_LINES_PAGE = 5

const REQUEST_TIMEOUT_MS = 30_000
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const RETRY_DELAYS_MS = [1_000, 3_000]

export interface ShopifyCredentials {
  /** Normalized myshopify.com domain. */
  shopDomain: string
  clientId: string
  clientSecret: string
}

/** A run-scoped session: the exchanged token lives ~24h and is never stored. */
export interface ShopifySession {
  shopDomain: string
  accessToken: string
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for network-level / GraphQL-level failures. */
    readonly status: number,
    /** GraphQL error code (e.g. ACCESS_DENIED) or OAuth error, if any. */
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'ShopifyApiError'
  }
}

/**
 * Whether an API error means the credentials themselves are dead (app deleted
 * or secret rotated in the Dev Dashboard), as opposed to a transient failure.
 * Used to flip a connection to status 'revoked' so the UI offers a reconnect
 * instead of the cron retrying forever.
 */
export function isRevokedCredentialsError(error: unknown): boolean {
  if (!(error instanceof ShopifyApiError)) return false
  return error.status === 401 || error.status === 403
}

/**
 * Normalize user input to a bare myshopify.com domain. Accepts the domain
 * with or without scheme/path, the bare store handle, and a pasted admin URL
 * (admin.shopify.com/store/<handle>). Anything that does not resolve to
 * <handle>.myshopify.com returns null: the Admin API only lives there, and
 * refusing arbitrary hosts doubles as the SSRF guard (the server never
 * fetches a user-controlled hostname).
 */
export function normalizeShopDomain(input: string): string | null {
  let value = input.trim().toLowerCase()
  if (!value) return null
  const adminMatch =
    /^(?:https?:\/\/)?admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)(?:[/?#]|$)/.exec(value)
  if (adminMatch) return `${adminMatch[1]}.myshopify.com`
  value = value.replace(/^https?:\/\//, '')
  value = value.split(/[/?#]/)[0]
  if (!value) return null
  if (!value.includes('.')) value = `${value}.myshopify.com`
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value) ? value : null
}

/** Error code on a ShopifyApiError when the stored shop domain fails re-normalisation. */
export const INVALID_SHOP_DOMAIN_CODE = 'accounted_invalid_shop_domain'
/** Error code on a ShopifyApiError when the SSRF guard refused to connect. */
export const UNSAFE_SHOP_URL_CODE = 'accounted_unsafe_shop_url'

/**
 * Re-run the connect-time normalisation on the STORED shop domain at use
 * time and return the https origin to call. The connect route normalises what
 * the user typed, but a member can PATCH `shop_domain` straight into the row
 * through PostgREST, so the database value is not trusted to still be a
 * myshopify.com host. Anything else is refused with a clear, non-retryable
 * error instead of fetched.
 */
function shopOriginOf(shopDomain: string): string {
  const normalized = normalizeShopDomain(shopDomain)
  if (!normalized) {
    throw new ShopifyApiError(
      `Shopify shop domain is not a myshopify.com domain (${shopDomain}); reconnect the store`,
      0,
      INVALID_SHOP_DOMAIN_CODE,
    )
  }
  return `https://${normalized}`
}

/**
 * Map a failure from postJson to the error the retry loop should see. Guard
 * refusals (private address, redirect) are terminal: retrying the same URL
 * cannot succeed and must not spend the backoff budget.
 */
function asTerminalGuardError(err: unknown): ShopifyApiError | null {
  if (err instanceof ShopifyApiError) return err
  if (isUnsafeUrlError(err)) {
    return new ShopifyApiError(
      `Shopify host refused by outbound URL guard: ${err.detail}`,
      0,
      UNSAFE_SHOP_URL_CODE,
    )
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  // safeFetch: public address only (checked now, not at connect time), no
  // redirects. A 3xx from the host is a failure, never a hop.
  return safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

/**
 * Exchange the custom app's client id/secret for an access token
 * (client credentials grant; expires_in ~86400s). Any 4xx here means the
 * credentials are unusable (invalid_client, app uninstalled, plan gate), so
 * it is reported as status 401 and classified as revoked; 429/5xx retry on
 * the normal backoff schedule.
 */
export async function exchangeAccessToken(creds: ShopifyCredentials): Promise<string> {
  // Throws (non-retryable) when the stored domain is not a myshopify.com host.
  const url = `${shopOriginOf(creds.shopDomain)}/admin/oauth/access_token`
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let response: Response
    try {
      response = await postJson(
        url,
        {
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          grant_type: 'client_credentials',
        },
        {},
      )
    } catch (err) {
      const terminal = asTerminalGuardError(err)
      if (terminal) throw terminal
      lastError = new ShopifyApiError(
        `Shopify token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
      )
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw lastError
    }

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as {
        access_token?: unknown
      } | null
      if (typeof body?.access_token === 'string' && body.access_token) {
        return body.access_token
      }
      throw new ShopifyApiError('Shopify token exchange returned no access token', 0)
    }

    if (RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      lastError = new ShopifyApiError(
        `Shopify token exchange ${response.status}`,
        response.status,
      )
      await sleep(RETRY_DELAYS_MS[attempt])
      continue
    }

    const errorBody = (await response.json().catch(() => null)) as {
      error?: string
      error_description?: string
    } | null
    // Only non-retryable 4xx means the credentials are unusable. A 429 that
    // survived every retry is still throttling, not revocation: mapping it to
    // 401 would classify as revoked and delete the stored credentials.
    const credentialFailure =
      response.status >= 400 &&
      response.status < 500 &&
      !RETRYABLE_STATUS.has(response.status)
    throw new ShopifyApiError(
      `Shopify token exchange ${response.status}${
        errorBody?.error_description ? `: ${errorBody.error_description}` : ''
      }`,
      credentialFailure ? 401 : response.status,
      errorBody?.error ?? null,
    )
  }
  throw lastError instanceof Error
    ? lastError
    : new ShopifyApiError('Shopify token exchange failed', 0)
}

/** Exchange the credentials for a run-scoped session. */
export async function createShopifySession(
  creds: ShopifyCredentials,
): Promise<ShopifySession> {
  return { shopDomain: creds.shopDomain, accessToken: await exchangeAccessToken(creds) }
}

interface GraphQLErrorShape {
  message?: string
  extensions?: { code?: string }
}

/**
 * POST one GraphQL query. Retries THROTTLED (HTTP 200 + GraphQL error code),
 * 429/5xx and network errors with a short backoff; 401/403 (token expired
 * mid-run, app revoked) and ACCESS_DENIED (scope missing) throw a
 * ShopifyApiError that classifies as revoked.
 */
export async function shopifyGraphQL<T>(
  session: ShopifySession,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  // Throws (non-retryable) when the stored domain is not a myshopify.com host.
  const url = `${shopOriginOf(session.shopDomain)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let response: Response
    try {
      response = await postJson(url, { query, variables }, {
        'X-Shopify-Access-Token': session.accessToken,
      })
    } catch (err) {
      const terminal = asTerminalGuardError(err)
      if (terminal) throw terminal
      lastError = new ShopifyApiError(
        `Shopify request failed: ${err instanceof Error ? err.message : String(err)}`,
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
        lastError = new ShopifyApiError(`Shopify API ${response.status}`, response.status)
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw new ShopifyApiError(`Shopify API ${response.status}`, response.status)
    }

    const body = (await response.json().catch(() => null)) as {
      data?: T
      errors?: GraphQLErrorShape[]
    } | null

    if (body?.errors && body.errors.length > 0) {
      const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED')
      if (throttled && attempt < RETRY_DELAYS_MS.length) {
        lastError = new ShopifyApiError('Shopify API throttled', 0, 'THROTTLED')
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      const accessDenied = body.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')
      const message = body.errors[0]?.message ?? 'unknown GraphQL error'
      throw new ShopifyApiError(
        `Shopify GraphQL error: ${message}`,
        accessDenied ? 403 : 0,
        body.errors[0]?.extensions?.code ?? null,
      )
    }

    if (!body?.data) {
      throw new ShopifyApiError('Shopify API returned no data', 0)
    }
    return body.data
  }
  throw lastError instanceof Error
    ? lastError
    : new ShopifyApiError('Shopify request failed', 0)
}

/**
 * Order fields for the feed. Deliberately NO customer/PII fields (customer,
 * email, addresses): they are gated behind Shopify's protected customer data
 * program, and the order feed does not need them; the verifikat reference is
 * the order name/id. Tax lines, line items and shipping lines carry the
 * booking underlag (per-rate VAT, line snapshot) for the Orders page.
 * Refunds come inline (plain list, not a connection), so no per-order
 * follow-up requests are needed.
 */
const ORDERS_QUERY = `
query OrdersFeed($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId
      name
      test
      createdAt
      processedAt
      updatedAt
      displayFinancialStatus
      paymentGatewayNames
      taxesIncluded
      totalPriceSet { shopMoney { amount currencyCode } }
      taxLines { ratePercentage priceSet { shopMoney { amount currencyCode } } }
      lineItems(first: ${SHOPIFY_LINE_ITEMS_PAGE}) {
        pageInfo { hasNextPage }
        nodes {
          name
          quantity
          discountedTotalSet { shopMoney { amount currencyCode } }
          taxLines { ratePercentage priceSet { shopMoney { amount currencyCode } } }
        }
      }
      shippingLines(first: ${SHOPIFY_SHIPPING_LINES_PAGE}) {
        pageInfo { hasNextPage }
        nodes {
          title
          discountedPriceSet { shopMoney { amount currencyCode } }
          taxLines { ratePercentage priceSet { shopMoney { amount currencyCode } } }
        }
      }
      refunds {
        legacyResourceId
        createdAt
        totalRefundedSet { shopMoney { amount currencyCode } }
      }
    }
  }
}`

export interface OrdersPage {
  orders: ShopifyOrder[]
  hasNextPage: boolean
  endCursor: string | null
}

export interface ListOrdersOptions {
  /** ISO timestamp; orders with updated_at >= this are listed. */
  updatedAtMin: string
  /** Relay cursor from the previous page's endCursor, or null for page one. */
  after: string | null
}

/**
 * One page of orders updated on/after the window start, oldest-updated first
 * so the caller's cursor advances chronologically. Relay cursor pagination is
 * stable across same-second ties, so no offset fallback is needed (unlike the
 * WooCommerce client).
 */
export async function listOrdersPage(
  session: ShopifySession,
  options: ListOrdersOptions,
): Promise<OrdersPage> {
  const data = await shopifyGraphQL<{
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: ShopifyOrder[]
    }
  }>(session, ORDERS_QUERY, {
    first: SHOPIFY_PAGE_SIZE,
    after: options.after,
    query: `updated_at:>='${options.updatedAtMin}'`,
  })
  return {
    orders: data.orders.nodes,
    hasNextPage: data.orders.pageInfo.hasNextPage,
    endCursor: data.orders.pageInfo.endCursor,
  }
}

const PROBE_QUERY = `
query ConnectProbe {
  shop { name currencyCode }
  orders(first: 1) { nodes { legacyResourceId } }
}`

/**
 * Verify credentials and read shop metadata. The one-order probe inside the
 * query is the authoritative check: it exercises the read_orders scope the
 * feed needs, so an app created without that scope fails here (ACCESS_DENIED)
 * instead of at 03:15.
 */
export async function testConnectionAndFetchShopInfo(
  creds: ShopifyCredentials,
): Promise<ShopifyShopInfo> {
  const session = await createShopifySession(creds)
  const data = await shopifyGraphQL<{
    shop: { name: string | null; currencyCode: string | null }
  }>(session, PROBE_QUERY)
  return {
    name: data.shop?.name ?? null,
    currency: data.shop?.currencyCode ? data.shop.currencyCode.toUpperCase() : null,
  }
}
