import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  normalizeShopDomain,
  exchangeAccessToken,
  shopifyGraphQL,
  listOrdersPage,
  isRevokedCredentialsError,
  testConnectionAndFetchShopInfo,
  fetchGrantedScopes,
  ShopifyApiError,
  ShopifyConnectError,
  SHOPIFY_API_VERSION,
  SHOPIFY_PAGE_SIZE,
  INVALID_SHOP_DOMAIN_CODE,
  UNSAFE_SHOP_URL_CODE,
  type ShopifyCredentials,
  type ShopifySession,
} from '../lib/api-client'

// The SSRF guard resolves DNS. Stub the validator (same seam the webhook
// dispatcher tests use) so tests are deterministic and offline; a dedicated
// test below flips it to a private-address verdict.
const guard = vi.hoisted(() => ({ validateUrl: vi.fn() }))
vi.mock('@/lib/webhooks/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/webhooks/url-guard')>()
  return {
    ...actual,
    validateWebhookUrl: (...args: unknown[]) => guard.validateUrl(...args),
  }
})

const CREDS: ShopifyCredentials = {
  shopDomain: 'minbutik.myshopify.com',
  clientId: 'client-id',
  clientSecret: 'client-secret',
}
const SESSION: ShopifySession = {
  shopDomain: 'minbutik.myshopify.com',
  accessToken: 'token-1',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  guard.validateUrl.mockReset()
  guard.validateUrl.mockImplementation(async (rawUrl: string) => ({
    ok: true,
    hostname: new URL(rawUrl).hostname,
    resolvedAddresses: ['203.0.113.10'],
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeShopDomain', () => {
  it('accepts the full myshopify.com domain in any casing, with or without scheme', () => {
    expect(normalizeShopDomain('minbutik.myshopify.com')).toBe('minbutik.myshopify.com')
    expect(normalizeShopDomain('  MinButik.MyShopify.com  ')).toBe('minbutik.myshopify.com')
    expect(normalizeShopDomain('https://minbutik.myshopify.com')).toBe('minbutik.myshopify.com')
    expect(normalizeShopDomain('https://minbutik.myshopify.com/admin')).toBe(
      'minbutik.myshopify.com',
    )
  })

  it('expands a bare store handle', () => {
    expect(normalizeShopDomain('minbutik')).toBe('minbutik.myshopify.com')
  })

  it('accepts a pasted admin URL', () => {
    expect(normalizeShopDomain('https://admin.shopify.com/store/minbutik')).toBe(
      'minbutik.myshopify.com',
    )
    expect(normalizeShopDomain('admin.shopify.com/store/minbutik/settings/apps')).toBe(
      'minbutik.myshopify.com',
    )
  })

  it('rejects anything that is not a myshopify.com host (SSRF guard)', () => {
    expect(normalizeShopDomain('minbutik.se')).toBeNull()
    expect(normalizeShopDomain('192.168.1.1')).toBeNull()
    expect(normalizeShopDomain('https://evil.example.com/x.myshopify.com')).toBeNull()
    expect(normalizeShopDomain('sub.domain.myshopify.com')).toBeNull()
    expect(normalizeShopDomain('')).toBeNull()
    // A bare word expands to <word>.myshopify.com, which is Shopify-owned:
    // safe by construction, never a private host.
    expect(normalizeShopDomain('localhost')).toBe('localhost.myshopify.com')
  })
})

describe('exchangeAccessToken', () => {
  it('POSTs the client credentials grant and returns the token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'token-1', expires_in: 86399 }),
    )
    await expect(exchangeAccessToken(CREDS)).resolves.toBe('token-1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://minbutik.myshopify.com/admin/oauth/access_token')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'client_credentials',
    })
    // Guarded transport: no redirect following, DNS check ran for this URL.
    expect((init as RequestInit).redirect).toBe('manual')
    expect(guard.validateUrl).toHaveBeenCalledWith(url, undefined)
  })

  it('classifies a non-retryable 4xx as revoked credentials', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'invalid_client' }, 400),
    )
    const error = await exchangeAccessToken(CREDS).catch((e) => e)
    expect(error).toBeInstanceOf(ShopifyApiError)
    expect(isRevokedCredentialsError(error)).toBe(true)
    expect((error as ShopifyApiError).code).toBe('invalid_client')
  })

  it('does NOT classify sustained throttling (429) as revoked credentials', async () => {
    // A persistent 429 that survives every retry is still throttling.
    // Classifying it as revoked would delete the stored credentials and force
    // the merchant to reconnect over a rate limit.
    fetchMock.mockResolvedValue(jsonResponse({}, 429))
    const error = await exchangeAccessToken(CREDS).catch((e) => e)
    expect(error).toBeInstanceOf(ShopifyApiError)
    expect((error as ShopifyApiError).status).toBe(429)
    expect(isRevokedCredentialsError(error)).toBe(false)
  }, 15_000)

  it('refuses a stored shop_domain that is not a myshopify.com host (edited outside the app) before any fetch', async () => {
    for (const shopDomain of ['minbutik.se', '10.0.0.5', 'https://evil.example.com/x.myshopify.com', '']) {
      const error = await exchangeAccessToken({ ...CREDS, shopDomain }).catch((e) => e)
      expect(error).toBeInstanceOf(ShopifyApiError)
      expect((error as ShopifyApiError).code).toBe(INVALID_SHOP_DOMAIN_CODE)
      expect((error as ShopifyApiError).status).toBe(0)
      // Not a credentials problem: the row is malformed, not revoked upstream.
      expect(isRevokedCredentialsError(error)).toBe(false)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a myshopify.com host that resolves to a private address, without retrying', async () => {
    guard.validateUrl.mockResolvedValue({
      ok: false,
      reason: 'private_address',
      detail: 'Resolved address 10.1.2.3 for minbutik.myshopify.com is not publicly routable (private_address).',
    })

    const error = await exchangeAccessToken(CREDS).catch((e) => e)

    expect(error).toBeInstanceOf(ShopifyApiError)
    expect((error as ShopifyApiError).code).toBe(UNSAFE_SHOP_URL_CODE)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(guard.validateUrl).toHaveBeenCalledTimes(1)
  })
})

describe('shopifyGraphQL', () => {
  it('sends the token header against the pinned API version and returns data', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { shop: { name: 'Butiken' } } }))
    const data = await shopifyGraphQL<{ shop: { name: string } }>(SESSION, 'query { shop { name } }')
    expect(data.shop.name).toBe('Butiken')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      `https://minbutik.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    )
    expect((init as RequestInit).headers).toMatchObject({
      'X-Shopify-Access-Token': 'token-1',
    })
    expect((init as RequestInit).redirect).toBe('manual')
  })

  it('retries a THROTTLED response before surfacing data', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }))
    await expect(shopifyGraphQL(SESSION, 'query { ok }')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 15_000)

  it('classifies ACCESS_DENIED as revoked (missing scope)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }],
      }),
    )
    const error = await shopifyGraphQL(SESSION, 'query { orders }').catch((e) => e)
    expect(isRevokedCredentialsError(error)).toBe(true)
  })

  it('classifies HTTP 401 as revoked without retrying', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401))
    const error = await shopifyGraphQL(SESSION, 'query { ok }').catch((e) => e)
    expect(isRevokedCredentialsError(error)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats a redirect as a failure, not a hop, and does not retry it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { Location: 'http://10.0.0.1/' } }),
    )

    const error = await shopifyGraphQL(SESSION, 'query { ok }').catch((e) => e)

    expect(error).toBeInstanceOf(ShopifyApiError)
    expect((error as ShopifyApiError).code).toBe(UNSAFE_SHOP_URL_CODE)
    expect(isRevokedCredentialsError(error)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a session whose shop domain is not a myshopify.com host before any fetch', async () => {
    const error = await shopifyGraphQL(
      { ...SESSION, shopDomain: 'internal.example' },
      'query { ok }',
    ).catch((e) => e)

    expect((error as ShopifyApiError).code).toBe(INVALID_SHOP_DOMAIN_CODE)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('listOrdersPage', () => {
  it('passes the window filter and cursor and unwraps the connection', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          orders: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
            nodes: [{ legacyResourceId: '1042', name: '#1042' }],
          },
        },
      }),
    )
    const page = await listOrdersPage(SESSION, {
      updatedAtMin: '2026-05-01T00:00:00.000Z',
      after: 'cursor-1',
    })
    expect(page.hasNextPage).toBe(true)
    expect(page.endCursor).toBe('cursor-2')
    expect(page.orders).toHaveLength(1)

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.variables).toEqual({
      first: SHOPIFY_PAGE_SIZE,
      after: 'cursor-1',
      query: "updated_at:>='2026-05-01T00:00:00.000Z'",
    })
    expect(page.addressesWithheld).toBe(false)
  })

  const OPTIONS = { updatedAtMin: '2026-05-01T00:00:00.000Z', after: null }

  function sentQuery(call: number): string {
    return JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string).query
  }

  function ordersData(nodes: unknown[]) {
    return { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }
  }

  it('asks for the country codes only, nothing else from the addresses', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: ordersData([
          {
            legacyResourceId: '1042',
            shippingAddress: { countryCodeV2: 'NO' },
            billingAddress: { countryCodeV2: 'SE' },
          },
        ]),
      }),
    )
    const page = await listOrdersPage(SESSION, OPTIONS)
    expect(page.orders[0].shippingAddress).toEqual({ countryCodeV2: 'NO' })
    expect(page.orders[0].billingAddress).toEqual({ countryCodeV2: 'SE' })
    expect(sentQuery(0)).toContain('shippingAddress { countryCodeV2 }')
    expect(sentQuery(0)).toContain('billingAddress { countryCodeV2 }')
    // Each line's physical-product flag decides whether billing may stand in (#98).
    expect(sentQuery(0)).toMatch(/lineItems\([^)]*\) \{[\s\S]*requiresShipping/)
    expect(sentQuery(0)).not.toMatch(/address1|address2|zip|city|province|email|phone|customer|firstName|lastName/)
  })

  it('tolerates the documented protected-data refusal: null field plus a field-scoped error', async () => {
    // Shopify's documented shape for a field the app may not read: HTTP 200,
    // the field null in data, an errors entry whose path points at it.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: ordersData([
          { legacyResourceId: '1042', shippingAddress: null, billingAddress: null },
          { legacyResourceId: '1043', shippingAddress: null, billingAddress: null },
        ]),
        errors: [
          {
            message:
              'This app is not approved to access the MailingAddress object. See https://partners.shopify.com/1/apps/2/customer_data for more details.',
            path: ['orders', 'nodes', 0, 'shippingAddress'],
            extensions: { code: 'ACCESS_DENIED' },
          },
          {
            message: 'This app is not approved to use the countryCodeV2 field.',
            path: ['orders', 'nodes', 1, 'shippingAddress', 'countryCodeV2'],
          },
          {
            message:
              'This app is not approved to access the MailingAddress object. See https://partners.shopify.com/1/apps/2/customer_data for more details.',
            path: ['orders', 'nodes', 0, 'billingAddress'],
            extensions: { code: 'ACCESS_DENIED' },
          },
        ],
      }),
    )
    const page = await listOrdersPage(SESSION, OPTIONS)
    expect(page.orders).toHaveLength(2)
    expect(page.addressesWithheld).toBe(true)
    // Answered in place: no retry, and nothing classified as revoked.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('tolerates a withheld billing address on its own (a digital order never fails the page)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: ordersData([{ legacyResourceId: '2001', shippingAddress: null, billingAddress: null }]),
        errors: [
          {
            message: 'This app is not approved to access the MailingAddress object.',
            path: ['orders', 'nodes', 0, 'billingAddress'],
            extensions: { code: 'ACCESS_DENIED' },
          },
        ],
      }),
    )
    const page = await listOrdersPage(SESSION, OPTIONS)
    expect(page.orders).toHaveLength(1)
    expect(page.addressesWithheld).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries once without the address when the whole query is refused, so the sync keeps working', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: ordersData([{ legacyResourceId: '1042' }]) }))
    const page = await listOrdersPage(SESSION, OPTIONS)
    expect(page.orders).toHaveLength(1)
    expect(page.addressesWithheld).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentQuery(0)).toContain('shippingAddress')
    expect(sentQuery(0)).toContain('billingAddress')
    // The retry asks for exactly the fields that worked before the
    // addresses were added: no address and no shipping flag.
    expect(sentQuery(1)).not.toMatch(/shippingAddress|billingAddress|requiresShipping/)
  })

  it('still classifies as revoked when the query is refused without the address too (read_orders missing)', async () => {
    const denied = () =>
      jsonResponse({ errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }] })
    fetchMock.mockResolvedValueOnce(denied()).mockResolvedValueOnce(denied())
    const error = await listOrdersPage(SESSION, OPTIONS).catch((e) => e)
    expect(isRevokedCredentialsError(error)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('still fails on an error outside the shipping address, even next to a tolerated one', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: ordersData([{ legacyResourceId: '1042', shippingAddress: null }]),
        errors: [
          { message: 'withheld', path: ['orders', 'nodes', 0, 'shippingAddress'] },
          { message: 'Internal error', path: ['orders', 'nodes', 0, 'taxLines'] },
        ],
      }),
    )
    const error = await listOrdersPage(SESSION, OPTIONS).catch((e) => e)
    expect(error).toBeInstanceOf(ShopifyApiError)
    expect((error as ShopifyApiError).message).toContain('Internal error')
    expect(isRevokedCredentialsError(error)).toBe(false)
  })

  it('leaves the addresses out when the caller stopped asking for them', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: ordersData([]) }))
    const page = await listOrdersPage(SESSION, { ...OPTIONS, includeAddresses: false })
    expect(sentQuery(0)).not.toMatch(/shippingAddress|billingAddress|requiresShipping/)
    expect(page.addressesWithheld).toBe(false)
  })
})

describe('testConnectionAndFetchShopInfo', () => {
  const TOKEN = () => jsonResponse({ access_token: 'token-1', scope: 'read_orders', expires_in: 86399 })
  // Shopify's answer to the probe on a token without read_orders (PH 161).
  const ORDERS_DENIED = () =>
    jsonResponse({
      errors: [{ message: 'Access denied for orders field.', extensions: { code: 'ACCESS_DENIED' } }],
    })
  const grantedScopes = (...handles: string[]) =>
    jsonResponse({
      data: { currentAppInstallation: { accessScopes: handles.map((handle) => ({ handle })) } },
    })

  function sentQuery(call: number): string {
    return JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string).query
  }

  async function connectError(): Promise<ShopifyConnectError> {
    const error = await testConnectionAndFetchShopInfo(CREDS).catch((e) => e)
    expect(error).toBeInstanceOf(ShopifyConnectError)
    return error as ShopifyConnectError
  }

  it('returns the shop info and asks nothing more on a working store', async () => {
    fetchMock
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(
        jsonResponse({ data: { shop: { name: 'Butiken', currencyCode: 'sek' }, orders: { nodes: [] } } }),
      )
    await expect(testConnectionAndFetchShopInfo(CREDS)).resolves.toEqual({
      name: 'Butiken',
      currency: 'SEK',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentQuery(1)).toContain('query ConnectProbe')
  })

  it('names read_orders as not granted on the store when the active version has it but the store never approved it (PH 161)', async () => {
    fetchMock
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(ORDERS_DENIED())
      .mockResolvedValueOnce(grantedScopes('read_products'))
    const error = await connectError()
    expect(error.kind).toBe('orders_scope_not_granted')
    expect(error.grantedScopes).toEqual(['read_products'])
    // The granted set is read from the installation, not from the token
    // response's scope field (a readback of the version's declared scopes).
    expect(sentQuery(2)).toContain('currentAppInstallation')
    expect(error.underlying).toBeInstanceOf(ShopifyApiError)
    expect(error.message).toContain('Access denied for orders field.')
  })

  it('reports an installation with no granted scopes as read_orders not granted', async () => {
    fetchMock
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(ORDERS_DENIED())
      .mockResolvedValueOnce(grantedScopes())
    const error = await connectError()
    expect(error.kind).toBe('orders_scope_not_granted')
    expect(error.grantedScopes).toEqual([])
  })

  it('blames protected customer data when read_orders (or write_orders) is granted yet orders are refused', async () => {
    for (const scope of ['read_orders', 'write_orders']) {
      fetchMock.mockReset()
      fetchMock
        .mockResolvedValueOnce(TOKEN())
        .mockResolvedValueOnce(ORDERS_DENIED())
        .mockResolvedValueOnce(grantedScopes('read_products', scope))
      const error = await connectError()
      expect(error.kind).toBe('orders_protected_data')
    }
  })

  it('stays honest when the granted scopes cannot be read either', async () => {
    fetchMock
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(ORDERS_DENIED())
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }] }),
      )
    const error = await connectError()
    expect(error.kind).toBe('orders_access_denied')
    expect(error.grantedScopes).toBeNull()
  })

  it('says the app is not installed when the token exchange says so', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'invalid_request', error_description: 'The application is not installed on this shop.' },
        400,
      ),
    )
    const error = await connectError()
    expect(error.kind).toBe('app_not_installed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('says the app and store are in different organizations on shop_not_permitted', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'shop_not_permitted', error_description: 'Client credentials cannot be performed on this shop.' },
        400,
      ),
    )
    expect((await connectError()).kind).toBe('other_organization')
  })

  it('says the credentials were rejected on invalid_client', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_client' }, 400))
    expect((await connectError()).kind).toBe('credentials_rejected')
  })

  it('reports a Shopify-side failure as unreachable, not as a permission problem', async () => {
    fetchMock.mockResolvedValueOnce(TOKEN()).mockResolvedValueOnce(jsonResponse({}, 500))
    expect((await connectError()).kind).toBe('unreachable')
  })
})

describe('fetchGrantedScopes', () => {
  it('lists the handles and never throws', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: { currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, null, { handle: '' }] } },
      }),
    )
    await expect(fetchGrantedScopes(SESSION)).resolves.toEqual(['read_orders'])

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { currentAppInstallation: null } }))
    await expect(fetchGrantedScopes(SESSION)).resolves.toBeNull()

    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401))
    await expect(fetchGrantedScopes(SESSION)).resolves.toBeNull()
  })
})
