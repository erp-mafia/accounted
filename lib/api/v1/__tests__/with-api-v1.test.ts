/**
 * Integration tests for the v1 wrapper.
 *
 * Mocks `validateApiKey` and `createServiceClientNoCookies` so we can exercise
 * the wrapper's auth / scope / company-membership / idempotency / dry-run
 * branches deterministically.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

beforeAll(() => {
  // The wrapper's public-scope path now fails closed if these env vars are
  // missing; tests don't run against a real Supabase instance so we stub
  // values just to clear the guard.
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

// The wrapper's public-scope path calls @supabase/supabase-js#createClient
// directly to obtain an anon-key client (no service-role privilege).
// Stub it so tests don't need real SUPABASE env vars.
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return {
    ...actual,
    createClient: vi.fn().mockReturnValue({}),
  }
})

vi.mock('@/lib/api/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/idempotency')>(
    '@/lib/api/idempotency',
  )
  return {
    ...actual,
    checkIdempotencyKey: vi.fn(),
    storeIdempotencyResponse: vi.fn(),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  checkIdempotencyKey,
  storeIdempotencyResponse,
} from '@/lib/api/idempotency'
import { truncateIp, withApiV1 } from '../with-api-v1'
import { ok } from '../response'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCheckIdempotency = checkIdempotencyKey as ReturnType<typeof vi.fn>
const mockStoreIdempotency = storeIdempotencyResponse as ReturnType<typeof vi.fn>

function makeSupabaseStub(membership: { company_id: string; role: string } | null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: membership, error: null }),
          }),
        }),
      }),
    }),
  }
}

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, init)
}

// Helper that wraps an empty params promise for non-dynamic routes.
function emptyParams() {
  return { params: Promise.resolve({}) }
}

// What Next.js 16 ACTUALLY passes to a STATIC route's handler: `{ params:
// undefined }` (app-route module: `params: context.params ? ... : undefined`).
// `emptyParams()` above is NOT what the runtime hands a static route, so it
// masked #781. Use this for the real static-route contract.
function staticRouteContext() {
  return { params: undefined } as unknown as { params: Promise<Record<string, never>> }
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockServiceClient.mockReturnValue(makeSupabaseStub(null))
})

describe('withApiV1 — auth', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const handler = withApiV1('companies.list', async (_req, ctx) =>
      ok({ ok: true }, { requestId: ctx.requestId }),
    )

    const res = await handler(makeRequest('https://x.test/api/v1/companies'), emptyParams())
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.request_id).toMatch(/^req_/)
  })

  it('returns 401 when validateApiKey rejects the token', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })

    const handler = withApiV1('companies.list', async (_req, ctx) =>
      ok({ ok: true }, { requestId: ctx.requestId }),
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies', {
        headers: { Authorization: 'Bearer gnubok_sk_invalid' },
      }),
      emptyParams(),
    )
    expect(res.status).toBe(401)
  })

  it('returns 429 when the underlying key is rate-limited', async () => {
    mockValidate.mockResolvedValue({ error: 'Rate limit exceeded', status: 429 })

    const handler = withApiV1('companies.list', async (_req, ctx) =>
      ok({ ok: true }, { requestId: ctx.requestId }),
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies', {
        headers: { Authorization: 'Bearer gnubok_sk_x' },
      }),
      emptyParams(),
    )
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error.code).toBe('RATE_LIMITED')
  })
})

describe('withApiV1 — scope', () => {
  it('returns 403 INSUFFICIENT_SCOPE when the key lacks the required scope', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      apiKeyId: 'ak_1',
      apiKeyName: 'test key',
      scopes: ['invoices:read'], // wrong scope
      mode: 'live',
    })

    const handler = withApiV1('companies.list', async (_req, ctx) =>
      ok({ ok: true }, { requestId: ctx.requestId }),
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies', {
        headers: { Authorization: 'Bearer gnubok_sk_x' },
      }),
      emptyParams(),
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(body.error.details.required_scope).toBe('companies:read')
  })

  it('returns 404 NOT_FOUND for unregistered endpoints (no leak)', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['companies:read'],
      mode: 'live',
    })

    const handler = withApiV1('mystery.endpoint', async (_req, ctx) =>
      ok({ ok: true }, { requestId: ctx.requestId }),
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/mystery', {
        headers: { Authorization: 'Bearer gnubok_sk_x' },
      }),
      emptyParams(),
    )
    expect(res.status).toBe(404)
  })
})

describe('withApiV1 — company membership', () => {
  it('returns 404 when the URL companyId is not a company the user belongs to', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['companies:read'],
      mode: 'live',
    })

    // No membership → null
    mockServiceClient.mockReturnValue(makeSupabaseStub(null))

    const handler = withApiV1(
      'companies.get',
      async (_req, ctx) => ok({ ok: true }, { requestId: ctx.requestId }),
      { requireScope: 'companies:read' },
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies/other-company', {
        headers: { Authorization: 'Bearer gnubok_sk_x' },
      }),
      companyParams('other-company'),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('allows the request when the user has membership in the URL company', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['companies:read'],
      mode: 'live',
    })

    mockServiceClient.mockReturnValue(makeSupabaseStub({ company_id: 'company-1', role: 'owner' }))

    const handler = withApiV1(
      'companies.get',
      async (_req, ctx) => ok({ companyId: ctx.companyId }, { requestId: ctx.requestId }),
      { requireScope: 'companies:read' },
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies/company-1', {
        headers: { Authorization: 'Bearer gnubok_sk_x' },
      }),
      companyParams('company-1'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.companyId).toBe('company-1')
  })
})

describe('withApiV1 — static (non-dynamic) route params', () => {
  // Regression for #781: GET /api/v1/companies is the only authenticated
  // static route. Next.js 16 hands it `{ params: undefined }`. The wrapper
  // must not null-deref on `params.params` after auth succeeds.
  it('does not 500 when Next passes { params: undefined } for a static route', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: undefined,
      scopes: ['companies:read'],
      mode: 'live',
    })

    let observedCompanyId: string | undefined = 'sentinel'
    let handlerCalled = false
    const handler = withApiV1('companies.list', async (_req, ctx) => {
      handlerCalled = true
      observedCompanyId = ctx.companyId
      return ok({ ok: true }, { requestId: ctx.requestId })
    })

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies', {
        headers: { Authorization: 'Bearer gnubok_sk_x' },
      }),
      staticRouteContext(),
    )

    expect(res.status).toBe(200)
    expect(handlerCalled).toBe(true)
    expect(observedCompanyId).toBeUndefined()
  })
})

describe('withApiV1 — idempotency', () => {
  it('replays a cached response when the idempotency key matches', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['invoices:write'],
      mode: 'live',
    })

    mockServiceClient.mockReturnValue(makeSupabaseStub({ company_id: 'company-1', role: 'owner' }))

    mockCheckIdempotency.mockResolvedValue({
      status: 'success',
      body: { data: { id: 'inv-cached' } },
    })

    const handler = withApiV1(
      'invoices.create',
      async () => {
        return NextResponse.json({ data: { id: 'inv-fresh' } }, { status: 201 })
      },
      { requireScope: 'invoices:write' },
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies/company-1/invoices', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer gnubok_sk_x',
          'Idempotency-Key': 'key-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ customer_id: 'cust-1' }),
      }),
      companyParams('company-1'),
    )

    expect(res.headers.get('Idempotent-Replayed')).toBe('true')
    const body = await res.json()
    expect(body.data.id).toBe('inv-cached')
  })

  it('honors the require-idempotency-key option', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['invoices:write'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeSupabaseStub({ company_id: 'company-1', role: 'owner' }))

    const handler = withApiV1(
      'invoices.create',
      async (_req, ctx) => ok({ ok: true }, { requestId: ctx.requestId }),
      { requireScope: 'invoices:write', requireIdempotencyKey: true },
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies/company-1/invoices', {
        method: 'POST',
        headers: { Authorization: 'Bearer gnubok_sk_x' },
      }),
      companyParams('company-1'),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('withApiV1 — dry-run', () => {
  it('threads dry_run=true from query string into context', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['invoices:write'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeSupabaseStub({ company_id: 'company-1', role: 'owner' }))

    let observedDryRun: boolean | null = null
    const handler = withApiV1(
      'invoices.create',
      async (_req, ctx) => {
        observedDryRun = ctx.dryRun
        return ok({ ok: true }, { requestId: ctx.requestId, dryRun: ctx.dryRun })
      },
      { requireScope: 'invoices:write' },
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies/company-1/invoices?dry_run=true', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer gnubok_sk_x',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      companyParams('company-1'),
    )

    expect(observedDryRun).toBe(true)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
  })

  it('threads X-Dry-Run header into context', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['invoices:write'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeSupabaseStub({ company_id: 'company-1', role: 'owner' }))

    let observedDryRun: boolean | null = null
    const handler = withApiV1(
      'invoices.create',
      async (_req, ctx) => {
        observedDryRun = ctx.dryRun
        return ok({ ok: true }, { requestId: ctx.requestId })
      },
      { requireScope: 'invoices:write' },
    )

    await handler(
      makeRequest('https://x.test/api/v1/companies/company-1/invoices', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer gnubok_sk_x',
          'X-Dry-Run': 'true',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      companyParams('company-1'),
    )

    expect(observedDryRun).toBe(true)
  })
})

describe('withApiV1 — test mode', () => {
  it('blocks a test-key write on a non-simulatable endpoint (403 TEST_KEY_WRITE_BLOCKED)', async () => {
    // No route modules are imported here, so the endpoint registry is empty →
    // getEndpointByConcretePath returns undefined → the wrapper must refuse the
    // write rather than let a test key mutate real data.
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['invoices:write'],
      mode: 'test',
    })
    mockServiceClient.mockReturnValue(makeSupabaseStub({ company_id: 'company-1', role: 'owner' }))

    let handlerCalled = false
    const handler = withApiV1(
      'invoices.create',
      async (_req, ctx) => {
        handlerCalled = true
        return ok({ ok: true }, { requestId: ctx.requestId })
      },
      { requireScope: 'invoices:write' },
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies/company-1/invoices', {
        method: 'POST',
        headers: { Authorization: 'Bearer gnubok_sk_x', 'Content-Type': 'application/json' },
        body: '{}',
      }),
      companyParams('company-1'),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('TEST_KEY_WRITE_BLOCKED')
    expect(handlerCalled).toBe(false)
  })

  it('allows a test-key READ unchanged — no forced dry-run, real data, X-Gnubok-Mode header', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['companies:read'],
      mode: 'test',
    })
    mockServiceClient.mockReturnValue(makeSupabaseStub({ company_id: 'company-1', role: 'owner' }))

    let observedDryRun: boolean | null = null
    const handler = withApiV1(
      'companies.get',
      async (_req, ctx) => {
        observedDryRun = ctx.dryRun
        return ok({ ok: true }, { requestId: ctx.requestId })
      },
      { requireScope: 'companies:read' },
    )

    const res = await handler(
      makeRequest('https://x.test/api/v1/companies/company-1', {
        headers: { Authorization: 'Bearer gnubok_sk_x' },
      }),
      companyParams('company-1'),
    )

    expect(res.status).toBe(200)
    expect(observedDryRun).toBe(false)
    expect(res.headers.get('X-Gnubok-Mode')).toBe('test')
  })
})

describe('withApiV1 — public endpoints', () => {
  it('invokes the handler without authentication for /api/v1/health', async () => {
    let observedUserId: string | null = null
    const handler = withApiV1('health.check', async (_req, ctx) => {
      observedUserId = ctx.userId
      return ok({ status: 'ok' }, { requestId: ctx.requestId })
    })

    const res = await handler(makeRequest('https://x.test/api/v1/health'), emptyParams())
    expect(res.status).toBe(200)
    expect(observedUserId).toBe('anonymous')
  })

  it('opportunistically attributes a valid Bearer token on a public route', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['companies:read'],
      mode: 'live',
    })

    let observedUserId: string | null = null
    let observedApiKeyId: string | undefined
    const handler = withApiV1('health.check', async (_req, ctx) => {
      observedUserId = ctx.userId
      observedApiKeyId = ctx.apiKeyId
      return ok({ status: 'ok' }, { requestId: ctx.requestId })
    })

    const res = await handler(
      makeRequest('https://x.test/api/v1/health', {
        headers: { Authorization: 'Bearer gnubok_sk_x' },
      }),
      emptyParams(),
    )

    expect(res.status).toBe(200)
    expect(observedUserId).toBe('user-1')
    expect(observedApiKeyId).toBe('ak_1')
  })

  it('silently downgrades an invalid Bearer token to anon on a public route', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })

    let observedUserId: string | null = null
    const handler = withApiV1('health.check', async (_req, ctx) => {
      observedUserId = ctx.userId
      return ok({ status: 'ok' }, { requestId: ctx.requestId })
    })

    const res = await handler(
      makeRequest('https://x.test/api/v1/health', {
        headers: { Authorization: 'Bearer gnubok_sk_invalid' },
      }),
      emptyParams(),
    )

    expect(res.status).toBe(200)
    expect(observedUserId).toBe('anonymous')
  })
})

describe('withApiV1 — stable headers', () => {
  it('always stamps X-Request-Id and Gnubok-Version', async () => {
    const handler = withApiV1('health.check', async (_req, ctx) =>
      ok({ status: 'ok' }, { requestId: ctx.requestId }),
    )

    const res = await handler(makeRequest('https://x.test/api/v1/health'), emptyParams())
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/)
    expect(res.headers.get('Gnubok-Version')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('truncateIp — privacy-preserving IP logging', () => {
  it('truncates IPv4 to /24', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.0/24')
  })

  it('truncates IPv6 to /48', () => {
    expect(truncateIp('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::/48')
  })

  it('returns undefined for an empty IP', () => {
    expect(truncateIp(undefined)).toBeUndefined()
    expect(truncateIp('')).toBeUndefined()
  })

  it('returns undefined for malformed input rather than leaking it raw', () => {
    expect(truncateIp('not-an-ip')).toBeUndefined()
  })

  it('rejects IPv4 with out-of-range octets to avoid pseudo-IPs in audit logs', () => {
    expect(truncateIp('999.999.999.999')).toBeUndefined()
    expect(truncateIp('256.0.0.1')).toBeUndefined()
    expect(truncateIp('192.168.1.300')).toBeUndefined()
  })

  it('accepts edge IPv4 octets (0 and 255)', () => {
    expect(truncateIp('0.0.0.0')).toBe('0.0.0.0/24')
    expect(truncateIp('255.255.255.255')).toBe('255.255.255.0/24')
  })
})

// Suppress unused-import warning — we re-export to keep the type chain visible.
void mockStoreIdempotency
