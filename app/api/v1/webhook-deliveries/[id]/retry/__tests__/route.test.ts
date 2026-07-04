/**
 * Integration tests for POST /api/v1/webhook-deliveries/:id/retry.
 *
 * The route lives outside the /companies/{companyId}/ tree (deliveries
 * already carry their company_id; nesting would force callers to
 * round-trip company resolution from the delivery id). Tenancy is still
 * enforced: the route resolves the delivery's company_id, then verifies
 * the caller is a member of that company via company_members.
 *
 * Closes the Phase 6 PR-1 (#496) integration-test debt for the retry
 * route.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`retry route tests require NODE_ENV=test`)
  }
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

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

vi.mock('@/lib/webhooks/url-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/webhooks/url-guard')>(
    '@/lib/webhooks/url-guard',
  )
  return {
    ...actual,
    validateWebhookUrl: vi.fn(),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { validateWebhookUrl } from '@/lib/webhooks/url-guard'
import { POST as retryDelivery } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockUrlGuard = validateWebhookUrl as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WEBHOOK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DELIVERY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NEW_DELIVERY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const USER_ID = 'user-1'

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      ...(init?.headers ?? {}),
    },
  })
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

const DEAD_DELIVERY = {
  id: DELIVERY_ID,
  webhook_id: WEBHOOK_ID,
  company_id: COMPANY_ID,
  event_type: 'invoice.paid',
  payload: { invoice_id: 'inv_x' },
  previous_attributes: null,
  api_version: '2026-05-12',
  status: 'dead' as const,
}

const ACTIVE_WEBHOOK = {
  id: WEBHOOK_ID,
  webhook_url: 'https://example.com/hooks',
  active: true,
  disabled_at: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['webhooks:manage'],
    mode: 'live',
  })
  mockUrlGuard.mockResolvedValue({
    ok: true,
    hostname: 'example.com',
    resolvedAddresses: ['203.0.113.42'],
  })
})

describe('POST /api/v1/webhook-deliveries/:id/retry', () => {
  it('re-enqueues a dead delivery as a fresh pending row', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        webhook_deliveries: [
          { data: DEAD_DELIVERY, error: null }, // lookup
          { data: { id: NEW_DELIVERY_ID }, error: null }, // insert
        ],
        company_members: { data: { company_id: COMPANY_ID }, error: null },
        webhooks: { data: ACTIVE_WEBHOOK, error: null },
      }),
    )

    const res = await retryDelivery(
      makeRequest(`https://x.test/api/v1/webhook-deliveries/${DELIVERY_ID}/retry`, {
        method: 'POST',
      }),
      idParams(DELIVERY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.webhook_delivery_id).toBe(NEW_DELIVERY_ID)
    expect(body.data.status).toBe('pending')
  })

  it('requires payroll:read for salary_run.* / agi.* retries (elevated-scope gate)', async () => {
    // Caller has webhooks:manage but NOT payroll:read. Original create
    // would have rejected the subscription; retry must reject the
    // re-emission identically so a stripped-down key can't replay payroll
    // payloads to its receiver.
    mockValidate.mockResolvedValueOnce({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['webhooks:manage'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        webhook_deliveries: {
          data: { ...DEAD_DELIVERY, event_type: 'salary_run.booked' },
          error: null,
        },
        company_members: { data: { company_id: COMPANY_ID }, error: null },
      }),
    )

    const res = await retryDelivery(
      makeRequest(`https://x.test/api/v1/webhook-deliveries/${DELIVERY_ID}/retry`, {
        method: 'POST',
      }),
      idParams(DELIVERY_ID),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(body.error.details.required_scope).toBe('payroll:read')
  })

  it('refuses to retry a live delivery (pending/in_flight/failed)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        webhook_deliveries: { data: { ...DEAD_DELIVERY, status: 'failed' }, error: null },
        company_members: { data: { company_id: COMPANY_ID }, error: null },
      }),
    )

    const res = await retryDelivery(
      makeRequest(`https://x.test/api/v1/webhook-deliveries/${DELIVERY_ID}/retry`, {
        method: 'POST',
      }),
      idParams(DELIVERY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.message).toMatch(/dead or delivered/i)
  })

  it('returns 404 NOT_FOUND when the caller is not a member of the delivery company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        webhook_deliveries: { data: DEAD_DELIVERY, error: null },
        // Non-member → 404, not 403, so we don't leak delivery existence.
        company_members: { data: null, error: null },
      }),
    )

    const res = await retryDelivery(
      makeRequest(`https://x.test/api/v1/webhook-deliveries/${DELIVERY_ID}/retry`, {
        method: 'POST',
      }),
      idParams(DELIVERY_ID),
    )

    expect(res.status).toBe(404)
  })

  it('refuses to retry against a disabled webhook', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        webhook_deliveries: { data: DEAD_DELIVERY, error: null },
        company_members: { data: { company_id: COMPANY_ID }, error: null },
        webhooks: {
          data: { ...ACTIVE_WEBHOOK, active: false, disabled_at: '2026-05-15T11:00:00Z' },
          error: null,
        },
      }),
    )

    const res = await retryDelivery(
      makeRequest(`https://x.test/api/v1/webhook-deliveries/${DELIVERY_ID}/retry`, {
        method: 'POST',
      }),
      idParams(DELIVERY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('refuses to retry when the webhook URL fails the SSRF re-check', async () => {
    mockUrlGuard.mockResolvedValueOnce({
      ok: false,
      reason: 'private_address',
      detail: '10.0.0.1 is private',
    })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        webhook_deliveries: { data: DEAD_DELIVERY, error: null },
        company_members: { data: { company_id: COMPANY_ID }, error: null },
        webhooks: { data: ACTIVE_WEBHOOK, error: null },
      }),
    )

    const res = await retryDelivery(
      makeRequest(`https://x.test/api/v1/webhook-deliveries/${DELIVERY_ID}/retry`, {
        method: 'POST',
      }),
      idParams(DELIVERY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.reason).toBe('private_address')
  })

  it('returns 404 NOT_FOUND when the delivery does not exist', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        webhook_deliveries: { data: null, error: null },
      }),
    )

    const res = await retryDelivery(
      makeRequest(`https://x.test/api/v1/webhook-deliveries/${DELIVERY_ID}/retry`, {
        method: 'POST',
      }),
      idParams(DELIVERY_ID),
    )

    expect(res.status).toBe(404)
  })

  it('returns 404 NOT_FOUND when the original webhook has been deleted', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        webhook_deliveries: { data: DEAD_DELIVERY, error: null },
        company_members: { data: { company_id: COMPANY_ID }, error: null },
        webhooks: { data: null, error: null }, // webhook deleted between dead and retry
      }),
    )

    const res = await retryDelivery(
      makeRequest(`https://x.test/api/v1/webhook-deliveries/${DELIVERY_ID}/retry`, {
        method: 'POST',
      }),
      idParams(DELIVERY_ID),
    )

    expect(res.status).toBe(404)
  })
})
