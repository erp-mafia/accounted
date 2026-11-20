import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  INVALID_STORE_URL_CODE,
  STORE_FIREWALL_CODE,
  UNSAFE_STORE_URL_CODE,
  WOO_USER_AGENT,
  isRevokedCredentialsError,
  listOrderRefunds,
  testConnectionAndFetchStoreInfo,
  wcGet,
  WooCommerceApiError,
  type WooCredentials,
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

const CREDS: WooCredentials = {
  storeUrl: 'https://shop.example.se',
  consumerKey: 'ck_test',
  consumerSecret: 'cs_test',
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeRefunds(startId: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    amount: '10.00',
    reason: '',
    date_created_gmt: '2026-08-01T10:00:00',
  }))
}

const fetchMock = vi.fn()

beforeEach(() => {
  // wcGet records the working auth mode on the credentials object.
  delete CREDS.authMode
  fetchMock.mockReset()
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

describe('wcGet: outbound URL guard', () => {
  it('happy path: Basic auth, no redirect following, and the DNS check runs per request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 1 }]))

    await expect(wcGet(CREDS, '/orders', { per_page: '1' })).resolves.toEqual([{ id: 1 }])

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://shop.example.se/wp-json/wc/v3/orders?per_page=1')
    expect(init.redirect).toBe('manual')
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(guard.validateUrl).toHaveBeenCalledWith(url, undefined)
  })

  it('refuses a stored store_url that no longer normalises (edited outside the app) before any fetch', async () => {
    for (const storeUrl of ['http://shop.example.se', 'https://10.0.0.5', 'https://localhost:8080', 'not a url']) {
      const error = await wcGet({ ...CREDS, storeUrl }, '/orders').catch((e) => e)
      expect(error).toBeInstanceOf(WooCommerceApiError)
      expect((error as WooCommerceApiError).wooCode).toBe(INVALID_STORE_URL_CODE)
      expect((error as WooCommerceApiError).status).toBe(0)
      expect((error as WooCommerceApiError).message).toMatch(/reconnect the store/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(guard.validateUrl).not.toHaveBeenCalled()
  })

  it('canonicalises a cosmetically different stored URL instead of refusing it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]))

    await wcGet({ ...CREDS, storeUrl: 'https://Shop.Example.se/' }, '/orders')

    expect(fetchMock.mock.calls[0][0]).toBe('https://shop.example.se/wp-json/wc/v3/orders')
  })

  it('refuses a public hostname that resolves to a private address, without retrying', async () => {
    guard.validateUrl.mockResolvedValue({
      ok: false,
      reason: 'private_address',
      detail: 'Resolved address 10.1.2.3 for shop.example.se is not publicly routable (private_address).',
    })

    const error = await wcGet(CREDS, '/orders').catch((e) => e)

    expect(error).toBeInstanceOf(WooCommerceApiError)
    expect((error as WooCommerceApiError).wooCode).toBe(UNSAFE_STORE_URL_CODE)
    expect((error as WooCommerceApiError).message).toMatch(/10\.1\.2\.3/)
    // Critically: no socket was opened and the backoff schedule was not spent.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(guard.validateUrl).toHaveBeenCalledTimes(1)
  })

  it('treats a redirect from the store as a failure, not a hop, and does not retry it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/' } }),
    )

    const error = await wcGet(CREDS, '/orders').catch((e) => e)

    expect(error).toBeInstanceOf(WooCommerceApiError)
    expect((error as WooCommerceApiError).wooCode).toBe(UNSAFE_STORE_URL_CODE)
    expect((error as WooCommerceApiError).message).toMatch(/redirects are never followed/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still falls back to query-string credentials on a 401 (header-stripping hosts)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'woocommerce_rest_cannot_view' }), { status: 401 }))
      .mockResolvedValueOnce(jsonResponse([{ id: 7 }]))

    await expect(wcGet(CREDS, '/orders')).resolves.toEqual([{ id: 7 }])

    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string)
    expect(secondUrl.searchParams.get('consumer_key')).toBe('ck_test')
    expect(secondUrl.searchParams.get('consumer_secret')).toBe('cs_test')
    expect((fetchMock.mock.calls[1][1] as RequestInit).redirect).toBe('manual')
  })
})

/** A Cloudflare-style refusal: HTML page, no WooCommerce JSON code. */
function firewallResponse(headers: Record<string, string> = {}): Response {
  return new Response(
    '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>',
    {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=UTF-8', Server: 'cloudflare', 'CF-RAY': '8a1b2c3d4e5f6789-ARN', ...headers },
    },
  )
}

function headersOf(call: unknown[]): Record<string, string> {
  return (call[1] as RequestInit).headers as Record<string, string>
}

describe('wcGet: firewalls and header-stripping hosts (crm#1669)', () => {
  it('sends an identifying User-Agent on every request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]))
    await wcGet(CREDS, '/orders')
    expect(headersOf(fetchMock.mock.calls[0])['User-Agent']).toBe(WOO_USER_AGENT)
  })

  it('tags an HTML 403 as a firewall refusal, keeps its diagnostics, and does not resend the keys in a URL', async () => {
    fetchMock.mockResolvedValueOnce(firewallResponse())

    const error = (await wcGet(CREDS, '/orders').catch((e) => e)) as WooCommerceApiError
    expect(error).toBeInstanceOf(WooCommerceApiError)
    expect(error.status).toBe(403)
    expect(error.wooCode).toBe(STORE_FIREWALL_CODE)
    expect(error.diagnostics).toMatchObject({
      bodyKind: 'html',
      server: 'cloudflare',
      cfRay: '8a1b2c3d4e5f6789-ARN',
      htmlTitle: 'Attention Required! | Cloudflare',
      queryAuth: false,
    })
    // No query-string retry: the same wall would only see the keys in a URL.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Never logged as a revoked key: the keys never reached WooCommerce.
    expect(isRevokedCredentialsError(error)).toBe(false)
  })

  it('treats a Cloudflare bot challenge as a firewall refusal even with a JSON-looking body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{}', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    )
    const error = (await wcGet(CREDS, '/orders').catch((e) => e)) as WooCommerceApiError
    expect(error.wooCode).toBe(STORE_FIREWALL_CODE)
    expect(error.diagnostics.cfMitigated).toBe('challenge')
  })

  it('falls back to query-string credentials on 403 woocommerce_rest_cannot_view and remembers it for the run', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.' }), { status: 403 }),
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 7 }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 8 }]))

    const creds: WooCredentials = { ...CREDS }
    await expect(wcGet(creds, '/orders')).resolves.toEqual([{ id: 7 }])
    expect(creds.authMode).toBe('query')
    const second = fetchMock.mock.calls[1]
    expect(new URL(second[0] as string).searchParams.get('consumer_key')).toBe('ck_test')
    expect(headersOf(second).Authorization).toBeUndefined()
    expect(headersOf(second)['User-Agent']).toBe(WOO_USER_AGENT)

    // The next call of the same run goes straight to the mode that worked.
    await expect(wcGet(creds, '/orders', { page: '2' })).resolves.toEqual([{ id: 8 }])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(new URL(fetchMock.mock.calls[2][0] as string).searchParams.get('consumer_key')).toBe('ck_test')
  })

  it('still reports a key WooCommerce refuses in both modes as revoked', async () => {
    const refused = () =>
      new Response(
        JSON.stringify({ code: 'woocommerce_rest_authentication_error', message: 'Consumer key is invalid.' }),
        { status: 401 },
      )
    fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(refused())

    const error = (await wcGet(CREDS, '/orders').catch((e) => e)) as WooCommerceApiError
    expect(error.status).toBe(401)
    expect(error.wooCode).toBe('woocommerce_rest_authentication_error')
    expect(error.message).toBe('WooCommerce API 401: Consumer key is invalid.')
    expect(error.diagnostics).toMatchObject({ bodyKind: 'json', queryAuth: true })
    expect(isRevokedCredentialsError(error)).toBe(true)
  })

  it('never puts the secret into the error it throws', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'woocommerce_rest_cannot_view' }), { status: 401 }))
      .mockResolvedValueOnce(firewallResponse())
    const error = (await wcGet(CREDS, '/orders').catch((e) => e)) as WooCommerceApiError
    expect(JSON.stringify({ m: error.message, d: error.diagnostics })).not.toContain('cs_test')
  })
})

describe('testConnectionAndFetchStoreInfo', () => {
  it('sends the User-Agent on the /wp-json/ title probe too', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ name: 'Butiken' }))

    await testConnectionAndFetchStoreInfo(CREDS)

    for (const call of fetchMock.mock.calls) {
      expect(headersOf(call)['User-Agent']).toBe(WOO_USER_AGENT)
    }
  })

  it('routes the public /wp-json/ title probe through the guard too', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }])) // /orders probe
      .mockResolvedValueOnce(jsonResponse([])) // /settings/general
      .mockResolvedValueOnce(jsonResponse({})) // /system_status
      .mockResolvedValueOnce(jsonResponse({ name: 'Butiken' })) // /wp-json/

    const info = await testConnectionAndFetchStoreInfo(CREDS)

    expect(info.name).toBe('Butiken')
    const [url, init] = fetchMock.mock.calls[3] as [string, RequestInit]
    expect(url).toBe('https://shop.example.se/wp-json/')
    expect(init.redirect).toBe('manual')
    expect(guard.validateUrl).toHaveBeenCalledTimes(4)
  })
})

describe('listOrderRefunds', () => {
  it('terminates on an empty page, not a short one (hosts may cap per_page)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRefunds(1, 50))) // short but non-empty
      .mockResolvedValueOnce(jsonResponse(makeRefunds(51, 50)))
      .mockResolvedValueOnce(jsonResponse([]))

    const refunds = await listOrderRefunds(CREDS, 42)
    expect(refunds).toHaveLength(100)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops when a host ignoring `page` repeats the same rows', async () => {
    // Fresh Response per call: a Response body is single-use.
    fetchMock.mockImplementation(async () => jsonResponse(makeRefunds(1, 100)))

    const refunds = await listOrderRefunds(CREDS, 42)
    expect(refunds).toHaveLength(100)
    // Page 1 full of fresh rows, page 2 identical → zero fresh → stop.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws instead of returning a silently partial list when the page cap is exhausted', async () => {
    // Ten full pages of genuinely fresh rows: the cap trips with data still
    // flowing, and a partial return would let the sync cursor pass unseen
    // refunds. The thrown error routes into the caller's held-cursor retry.
    fetchMock.mockImplementation(async (url: string | URL) => {
      const page = Number(new URL(String(url)).searchParams.get('page'))
      return jsonResponse(makeRefunds(page * 1000, 100))
    })

    await expect(listOrderRefunds(CREDS, 42)).rejects.toThrow(
      /Refund pagination cap exceeded/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(10)
  })
})
