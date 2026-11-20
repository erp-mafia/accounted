import { isUnsafeUrlError, safeFetch } from '@/lib/http/safe-fetch'
import type { ShopifyOrder, ShopifyShopInfo } from '../types'
import { sleep } from '@/lib/utils'

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
 * single GraphQL query must stay under the 1000-point ceiling. The requested
 * cost is linear in this number (2 + pageSize * per-order cost), and the
 * per-order cost is at least 36 (the order, lineItems 2 + 25, shippingLines
 * 2 + 5, shippingAddress 1), so a 25-order page cost at least 902. Each
 * address is one object with one enum (1 point per order; requiresShipping
 * is a scalar, 0): 24 orders with billingAddress added (#98) never cost more
 * than the 25 without it did, since 24 * (c + 1) <= 25 * c for any per-order
 * cost c >= 24.
 */
export const SHOPIFY_PAGE_SIZE = 24
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

/** GraphQL error code Shopify uses for a missing scope or a protected-data refusal. */
const ACCESS_DENIED_CODE = 'ACCESS_DENIED'

interface GraphQLErrorShape {
  message?: string
  extensions?: { code?: string }
  /** Response path of a field-level error, e.g. ['orders', 'nodes', 0, 'shippingAddress']. */
  path?: Array<string | number>
}

/** Whether a GraphQL error is scoped to (or below) one of the optional fields. */
function isOptionalFieldError(error: GraphQLErrorShape, optionalFields: readonly string[]): boolean {
  return (
    Array.isArray(error.path) &&
    error.path.some((segment) => typeof segment === 'string' && optionalFields.includes(segment))
  )
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
  return (await requestGraphQL<T>(session, query, variables, [])).data
}

/**
 * shopifyGraphQL, except that errors scoped to one of `optionalFields` are
 * returned instead of thrown, provided data came back. Shopify answers a
 * field the app may not read (protected customer data) with HTTP 200, null
 * in that field and an `errors` entry whose path points at it; for a field
 * the caller can do without, that is a degraded answer, not a failed one.
 * Errors anywhere else still throw exactly as in shopifyGraphQL.
 */
async function requestGraphQL<T>(
  session: ShopifySession,
  query: string,
  variables: Record<string, unknown>,
  optionalFields: readonly string[],
): Promise<{ data: T; optionalFieldErrors: GraphQLErrorShape[] }> {
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
      const fatal = body.errors.filter((e) => !isOptionalFieldError(e, optionalFields))
      if (fatal.length === 0 && body.data) {
        return { data: body.data, optionalFieldErrors: body.errors }
      }
      // Only errors outside the optional fields decide the classification: a
      // withheld optional field must never read as revoked credentials.
      const reported = fatal[0] ?? body.errors[0]
      const accessDenied = fatal.some((e) => e.extensions?.code === ACCESS_DENIED_CODE)
      const message = reported?.message ?? 'unknown GraphQL error'
      throw new ShopifyApiError(
        `Shopify GraphQL error: ${message}`,
        accessDenied ? 403 : 0,
        reported?.extensions?.code ?? null,
      )
    }

    if (!body?.data) {
      throw new ShopifyApiError('Shopify API returned no data', 0)
    }
    return { data: body.data, optionalFieldErrors: [] }
  }
  throw lastError instanceof Error
    ? lastError
    : new ShopifyApiError('Shopify request failed', 0)
}

/**
 * Order fields for the feed. Customer/PII fields stay out (customer, email,
 * names, street addresses): the order feed does not need them, and the
 * verifikat reference is the order name/id. The one exception is the
 * country code of the shipping and billing addresses and nothing else from
 * them: the destination decides how a goods sale is taxed (domestic, EU
 * distance sale under OSS, export; crm#1032), and for an order with nothing
 * to ship (digital products, services) the customer's billing country is the
 * evidence of where the customer is (#98). Each line's requiresShipping tells
 * the two apart; it rides with the addresses, so the fallback query without
 * them asks for exactly the fields that worked before either was added. Tax
 * lines, line items and shipping lines carry the booking underlag (per-rate
 * VAT, line snapshot). Refunds come inline (plain list, not a connection), so
 * no per-order follow-up requests are needed.
 *
 * Shopify counts addresses as protected customer data (the protected field
 * "Address", level 2, covering billing and shipping alike). A store that
 * withholds it from the app answers with the address null plus a
 * field-scoped error; listOrdersPage treats that as "no country", never as a
 * failed page.
 */
function buildOrdersQuery(includeAddresses: boolean): string {
  return `
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
      ${includeAddresses ? 'shippingAddress { countryCodeV2 }' : ''}
      ${includeAddresses ? 'billingAddress { countryCodeV2 }' : ''}
      lineItems(first: ${SHOPIFY_LINE_ITEMS_PAGE}) {
        pageInfo { hasNextPage }
        nodes {
          name
          quantity
          ${includeAddresses ? 'requiresShipping' : ''}
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
}

const ORDERS_QUERY = buildOrdersQuery(true)
const ORDERS_QUERY_WITHOUT_ADDRESSES = buildOrdersQuery(false)
/** The address fields a store may withhold without failing the page. */
const ADDRESS_FIELDS = ['shippingAddress', 'billingAddress'] as const

export interface OrdersPage {
  orders: ShopifyOrder[]
  hasNextPage: boolean
  endCursor: string | null
  /**
   * The store refused the addresses on this request (protected customer data
   * not granted to the app), so no order on the page carries a country. The
   * page is otherwise complete. False when the addresses were not asked for.
   */
  addressesWithheld: boolean
}

export interface ListOrdersOptions {
  /** ISO timestamp; orders with updated_at >= this are listed. */
  updatedAtMin: string
  /** Relay cursor from the previous page's endCursor, or null for page one. */
  after: string | null
  /**
   * Ask for the shipping and billing countries (default true). The sync
   * stops asking for the rest of a run once the store refused them.
   */
  includeAddresses?: boolean
}

interface OrdersData {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: ShopifyOrder[]
  }
}

function toOrdersPage(data: OrdersData, addressesWithheld: boolean): OrdersPage {
  return {
    orders: data.orders.nodes,
    hasNextPage: data.orders.pageInfo.hasNextPage,
    endCursor: data.orders.pageInfo.endCursor,
    addressesWithheld,
  }
}

/**
 * One page of orders updated on/after the window start, oldest-updated first
 * so the caller's cursor advances chronologically. Relay cursor pagination is
 * stable across same-second ties, so no offset fallback is needed (unlike the
 * WooCommerce client).
 *
 * A withheld address never fails the page. The documented answer (null field
 * plus a field-scoped error) is tolerated in place. Should the store instead
 * refuse the whole query with ACCESS_DENIED, the page is asked once more
 * without the addresses: only if that also fails is read_orders itself
 * missing, and the error propagates (classified as revoked) exactly as
 * before the addresses were added. Without this, adding one optional field
 * could flip a working connection to revoked and wipe its credentials.
 */
export async function listOrdersPage(
  session: ShopifySession,
  options: ListOrdersOptions,
): Promise<OrdersPage> {
  const variables = {
    first: SHOPIFY_PAGE_SIZE,
    after: options.after,
    query: `updated_at:>='${options.updatedAtMin}'`,
  }
  if (options.includeAddresses === false) {
    const data = await shopifyGraphQL<OrdersData>(session, ORDERS_QUERY_WITHOUT_ADDRESSES, variables)
    return toOrdersPage(data, false)
  }

  try {
    const { data, optionalFieldErrors } = await requestGraphQL<OrdersData>(
      session,
      ORDERS_QUERY,
      variables,
      ADDRESS_FIELDS,
    )
    return toOrdersPage(data, optionalFieldErrors.length > 0)
  } catch (error) {
    if (!(error instanceof ShopifyApiError) || error.code !== ACCESS_DENIED_CODE) throw error
    const data = await shopifyGraphQL<OrdersData>(session, ORDERS_QUERY_WITHOUT_ADDRESSES, variables)
    return toOrdersPage(data, true)
  }
}

const PROBE_QUERY = `
query ConnectProbe {
  shop { name currencyCode }
  orders(first: 1) { nodes { legacyResourceId } }
}`

/**
 * The scopes the store has actually granted this installation. A version's
 * declared scopes are not that: a scope added in a new app version only
 * reaches an installed store once the change is approved on the store, and
 * the client credentials token carries the granted set (PH 161).
 */
const GRANTED_SCOPES_QUERY = `
query GrantedScopes {
  currentAppInstallation { accessScopes { handle } }
}`

/**
 * Why connecting a store failed, as far as Shopify's answer tells. Each kind
 * maps to one thing the merchant changes in Shopify.
 */
export type ShopifyConnectFailureKind =
  /** Token exchange: the app exists but is not installed on this store. */
  | 'app_not_installed'
  /** Token exchange: shop_not_permitted, the app and store are in different organizations. */
  | 'other_organization'
  /** Token exchange refused the client id/secret (or the address is not that store's). */
  | 'credentials_rejected'
  /** The store has not granted read_orders to the installation (`grantedScopes` lists what it has). */
  | 'orders_scope_not_granted'
  /** read_orders is granted, yet orders are refused: protected customer data access is missing. */
  | 'orders_protected_data'
  /** Orders refused, and the granted scopes could not be read to tell the two causes apart. */
  | 'orders_access_denied'
  /** Network, 5xx, throttling or anything else: nothing for the merchant to change. */
  | 'unreachable'

export class ShopifyConnectError extends Error {
  constructor(
    readonly kind: ShopifyConnectFailureKind,
    /** The underlying failure, kept for the log line. */
    readonly underlying: unknown,
    /** Scopes the store has granted the app, when the probe could read them. */
    readonly grantedScopes: string[] | null = null,
  ) {
    super(underlying instanceof Error ? underlying.message : String(underlying))
    this.name = 'ShopifyConnectError'
  }
}

/** A write scope includes its read scope. */
function grantsOrderRead(scopes: readonly string[]): boolean {
  return scopes.includes('read_orders') || scopes.includes('write_orders')
}

/** The granted scope handles, or null when they cannot be read. Never throws. */
export async function fetchGrantedScopes(session: ShopifySession): Promise<string[] | null> {
  try {
    const data = await shopifyGraphQL<{
      currentAppInstallation: { accessScopes: Array<{ handle?: unknown } | null> | null } | null
    }>(session, GRANTED_SCOPES_QUERY)
    const scopes = data.currentAppInstallation?.accessScopes
    if (!Array.isArray(scopes)) return null
    return scopes
      .map((scope) => scope?.handle)
      .filter((handle): handle is string => typeof handle === 'string' && handle.length > 0)
  } catch {
    // Only enriches a connect error: unreadable scopes leave out the scope hint.
    return null
  }
}

/** Classify a failed token exchange (exchangeAccessToken's error). */
function tokenFailureKind(error: unknown): ShopifyConnectFailureKind {
  if (!(error instanceof ShopifyApiError)) return 'unreachable'
  if (/not installed/i.test(error.message)) return 'app_not_installed'
  if (error.code === 'shop_not_permitted' || /shop_not_permitted/i.test(error.message)) {
    return 'other_organization'
  }
  // exchangeAccessToken reports every non-retryable 4xx as 401.
  return error.status === 401 ? 'credentials_rejected' : 'unreachable'
}

/**
 * Verify credentials and read shop metadata. The one-order probe inside the
 * query is the authoritative check: it exercises the read_orders scope the
 * feed needs, so an app without that scope fails here (ACCESS_DENIED)
 * instead of at 03:15.
 *
 * Every failure is thrown as a ShopifyConnectError naming its cause. On
 * ACCESS_DENIED the granted scopes are read in a second request (failure
 * path only, so a working store's connect is unchanged): read_orders
 * missing from them means the store never approved it, typically a scope
 * added in a later app version; read_orders present means the refusal is
 * the protected customer data gate on orders.
 */
export async function testConnectionAndFetchShopInfo(
  creds: ShopifyCredentials,
): Promise<ShopifyShopInfo> {
  let session: ShopifySession
  try {
    session = await createShopifySession(creds)
  } catch (error) {
    throw new ShopifyConnectError(tokenFailureKind(error), error)
  }

  let data: { shop: { name: string | null; currencyCode: string | null } | null }
  try {
    data = await shopifyGraphQL(session, PROBE_QUERY)
  } catch (error) {
    if (error instanceof ShopifyApiError && error.code === ACCESS_DENIED_CODE) {
      const granted = await fetchGrantedScopes(session)
      const kind: ShopifyConnectFailureKind =
        granted === null
          ? 'orders_access_denied'
          : grantsOrderRead(granted)
            ? 'orders_protected_data'
            : 'orders_scope_not_granted'
      throw new ShopifyConnectError(kind, error, granted)
    }
    const rejected =
      error instanceof ShopifyApiError && (error.status === 401 || error.status === 403)
    throw new ShopifyConnectError(rejected ? 'credentials_rejected' : 'unreachable', error)
  }
  return {
    name: data.shop?.name ?? null,
    currency: data.shop?.currencyCode ? data.shop.currencyCode.toUpperCase() : null,
  }
}

/**
 * One order's billing contact, read on demand when the user creates an
 * invoice from that order (Skapa faktura), never by the feed. The sync keeps
 * storing no names or emails (crm#1032); this reads them one order at a time
 * and the caller keeps them only on the customer the user creates.
 *
 * Name, email and address are protected customer data (level 2 fields, which
 * Shopify grants a merchant's own app by plan). A store that withholds one
 * answers with null plus a field-scoped error, reported in `withheld` rather
 * than failing; a store that refuses the whole query (ACCESS_DENIED) reports
 * all three withheld. Neither ever reads as revoked credentials here.
 */
const ORDER_CONTACT_QUERY = `
query OrderContact($id: ID!) {
  order(id: $id) {
    email
    billingAddress { name firstName lastName company }
  }
}`

/** Fields the order contact lookup can report as withheld. */
export type ShopifyContactField = 'name' | 'company' | 'email'

export interface ShopifyOrderContact {
  name: string | null
  company: string | null
  email: string | null
  /** Fields the store did not share with the app (protected customer data). */
  withheld: ShopifyContactField[]
}

interface OrderContactData {
  order: {
    email: string | null
    billingAddress: {
      name: string | null
      firstName: string | null
      lastName: string | null
      company: string | null
    } | null
  } | null
}

const CONTACT_FIELDS: readonly ShopifyContactField[] = ['name', 'company', 'email']

function cleanContactText(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** The contact fields one field-scoped error covers. */
function withheldContactFields(error: GraphQLErrorShape): ShopifyContactField[] {
  const path = (error.path ?? []).filter((segment): segment is string => typeof segment === 'string')
  if (path.includes('email')) return ['email']
  if (!path.includes('billingAddress')) return []
  if (path.includes('company')) return ['company']
  if (path.some((segment) => segment === 'name' || segment === 'firstName' || segment === 'lastName')) {
    return ['name']
  }
  return ['name', 'company']
}

/**
 * The billing name, company and email of one order, by its numeric id
 * (legacyResourceId). Null when the store has no such order (deleted since
 * the sync, or another store's id).
 */
export async function fetchOrderContact(
  session: ShopifySession,
  orderId: string,
): Promise<ShopifyOrderContact | null> {
  let result: { data: OrderContactData; optionalFieldErrors: GraphQLErrorShape[] }
  try {
    result = await requestGraphQL<OrderContactData>(
      session,
      ORDER_CONTACT_QUERY,
      { id: `gid://shopify/Order/${orderId}` },
      ['email', 'billingAddress'],
    )
  } catch (error) {
    if (error instanceof ShopifyApiError && error.code === ACCESS_DENIED_CODE) {
      return { name: null, company: null, email: null, withheld: [...CONTACT_FIELDS] }
    }
    throw error
  }

  const order = result.data.order
  if (!order) return null
  const withheld = new Set<ShopifyContactField>()
  for (const error of result.optionalFieldErrors) {
    for (const field of withheldContactFields(error)) withheld.add(field)
  }
  const address = order.billingAddress
  const joinedName = [address?.firstName, address?.lastName]
    .map(cleanContactText)
    .filter((part): part is string => part !== null)
    .join(' ')
  return {
    name: cleanContactText(address?.name) ?? (joinedName || null),
    company: cleanContactText(address?.company),
    email: cleanContactText(order.email),
    withheld: CONTACT_FIELDS.filter((field) => withheld.has(field)),
  }
}
