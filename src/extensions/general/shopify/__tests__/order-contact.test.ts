import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchOrderContact, ShopifyApiError, type ShopifySession } from '../lib/api-client'

// The SSRF guard resolves DNS. Stub the validator (same seam the client suite
// uses) so the tests are deterministic and offline.
const guard = vi.hoisted(() => ({ validateUrl: vi.fn() }))
vi.mock('@/lib/webhooks/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/webhooks/url-guard')>()
  return {
    ...actual,
    validateWebhookUrl: (...args: unknown[]) => guard.validateUrl(...args),
  }
})

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

function requestBody(): { query: string; variables: { id: string } } {
  const init = fetchMock.mock.calls[0][1] as RequestInit
  return JSON.parse(init.body as string)
}

describe('fetchOrderContact', () => {
  it('reads one order by its global id and asks for nothing but the billing contact', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          order: {
            email: ' kund@example.se ',
            billingAddress: { name: 'Anna Andersson', firstName: 'Anna', lastName: 'Andersson', company: 'Kund AB' },
          },
        },
      }),
    )

    const contact = await fetchOrderContact(SESSION, '1001')

    expect(contact).toEqual({
      name: 'Anna Andersson',
      company: 'Kund AB',
      email: 'kund@example.se',
      withheld: [],
    })
    const body = requestBody()
    expect(body.variables).toEqual({ id: 'gid://shopify/Order/1001' })
    expect(body.query).toContain('billingAddress { name firstName lastName company }')
    // No street, phone or shipping address: only what the invoice customer needs.
    expect(body.query).not.toMatch(/address1|phone|shippingAddress|customer \{/)
  })

  it('joins first and last name when the address has no full name', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          order: {
            email: null,
            billingAddress: { name: null, firstName: 'Anna', lastName: 'Andersson', company: '  ' },
          },
        },
      }),
    )

    const contact = await fetchOrderContact(SESSION, '1001')

    expect(contact).toEqual({ name: 'Anna Andersson', company: null, email: null, withheld: [] })
  })

  it('reports the fields a store withholds instead of failing', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: { order: { email: null, billingAddress: null } },
        errors: [
          { message: 'This app is not approved to access the email field.', path: ['order', 'email'] },
          { message: 'This app is not approved to access addresses.', path: ['order', 'billingAddress'] },
        ],
      }),
    )

    const contact = await fetchOrderContact(SESSION, '1001')

    expect(contact).toEqual({
      name: null,
      company: null,
      email: null,
      withheld: ['name', 'company', 'email'],
    })
  })

  it('maps a withheld name inside the address to name only', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          order: {
            email: 'kund@example.se',
            billingAddress: { name: null, firstName: null, lastName: null, company: 'Kund AB' },
          },
        },
        errors: [
          { message: 'redacted', path: ['order', 'billingAddress', 'name'] },
          { message: 'redacted', path: ['order', 'billingAddress', 'firstName'] },
        ],
      }),
    )

    const contact = await fetchOrderContact(SESSION, '1001')

    expect(contact).toEqual({
      name: null,
      company: 'Kund AB',
      email: 'kund@example.se',
      withheld: ['name'],
    })
  })

  it('treats a refused query (ACCESS_DENIED) as everything withheld, not as revoked', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        errors: [{ message: 'Access denied', path: ['order'], extensions: { code: 'ACCESS_DENIED' } }],
      }),
    )

    const contact = await fetchOrderContact(SESSION, '1001')

    expect(contact).toEqual({
      name: null,
      company: null,
      email: null,
      withheld: ['name', 'company', 'email'],
    })
  })

  it('returns null when the store has no such order', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { order: null } }))

    expect(await fetchOrderContact(SESSION, '1001')).toBeNull()
  })

  it('still throws other API failures', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: 'Unauthorized' }, 401))

    await expect(fetchOrderContact(SESSION, '1001')).rejects.toBeInstanceOf(ShopifyApiError)
  })
})
