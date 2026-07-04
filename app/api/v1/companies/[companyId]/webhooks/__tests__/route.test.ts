/**
 * Integration tests for the v1 webhooks vertical (Phase 6 PR-1).
 *
 * Phase 6 PR-1 (#496) shipped the substrate with deferred integration
 * tests. This file closes the test debt for the company-scoped routes:
 *
 *   POST   /webhooks                       (create + secret-once)
 *   GET    /webhooks                       (list, no secret)
 *   GET    /webhooks/:id                   (detail)
 *   PATCH  /webhooks/:id                   (update + SSRF re-check)
 *   DELETE /webhooks/:id                   (hard delete, audit trail survives)
 *   POST   /webhooks/:id/test              (synthetic delivery)
 *   GET    /webhooks/:id/deliveries        (delivery audit list)
 *
 * Retry (POST /webhook-deliveries/:id/retry) is covered in its sibling
 * test file under app/api/v1/webhook-deliveries/.
 *
 * Mirrors the suppliers vertical test pattern: a Proxy-backed Supabase
 * mock returns whatever the route awaits, keyed by table name. Focus is
 * on outcome (status / body shape) rather than query mechanics: the
 * wrapper already validates auth, scope, idempotency, and company
 * membership.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `webhook route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
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

// SSRF DNS validation lives behind a network call (dns.resolve4/6). Stub
// it so we can deterministically force ok-vs-rejected outcomes; otherwise
// the test would actually resolve example.com and have flaky behavior in
// air-gapped CI.
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
import { GET as listWebhooks, POST as createWebhook } from '../route'
import {
  GET as getWebhook,
  PATCH as updateWebhook,
  DELETE as deleteWebhook,
} from '../[id]/route'
import { POST as testWebhook } from '../[id]/test/route'
import { GET as listDeliveries } from '../[id]/deliveries/route'
import { POST as rotateSecret } from '../[id]/rotate-secret/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockUrlGuard = validateWebhookUrl as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
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
const USER_ID = 'user-1'

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ...(init?.headers ?? {}),
    },
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

const SAMPLE_WEBHOOK = {
  id: WEBHOOK_ID,
  name: 'CRM sync',
  description: null,
  event_type: 'invoice.paid',
  webhook_url: 'https://example.com/hooks/gnubok',
  active: true,
  api_version_pinned: '2026-05-12',
  disabled_at: null,
  disabled_reason: null,
  created_at: '2026-05-15T12:00:00Z',
  updated_at: '2026-05-15T12:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['webhooks:manage', 'payroll:read'],
    mode: 'live',
  })
  // Default URL validation: always ok. Tests override per-case.
  mockUrlGuard.mockResolvedValue({
    ok: true,
    hostname: 'example.com',
    resolvedAddresses: ['203.0.113.42'],
  })
})

// ──────────────────────────────────────────────────────────────────────
// POST /webhooks  (create)
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/v1/companies/:companyId/webhooks', () => {
  it('returns 201 with the freshly-minted secret on success', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: SAMPLE_WEBHOOK, error: null },
      }),
    )

    const res = await createWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'invoice.paid',
          webhook_url: 'https://example.com/hooks/gnubok',
          name: 'CRM sync',
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.id).toBe(WEBHOOK_ID)
    // Secret is returned EXACTLY ONCE on create. We don't pin the prefix
    // shape too tightly: the contract is "non-empty string with whsec_
    // prefix" and the schema documents the exact length elsewhere.
    expect(typeof body.data.secret).toBe('string')
    expect(body.data.secret).toMatch(/^whsec_/)
  })

  it('returns 400 VALIDATION_ERROR when webhook_url is not https', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await createWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'invoice.paid',
          webhook_url: 'http://example.com/hooks',
          name: 'CRM sync',
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 VALIDATION_ERROR when the SSRF guard rejects the URL', async () => {
    mockUrlGuard.mockResolvedValueOnce({
      ok: false,
      reason: 'private_address',
      detail: '10.0.0.1 is private',
    })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await createWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'invoice.paid',
          webhook_url: 'https://internal.example/hooks',
          name: 'internal',
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.reason).toBe('private_address')
  })

  it('requires payroll:read for salary_run.* event types (elevated-scope gate)', async () => {
    // Key has webhooks:manage but NOT payroll:read.
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
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await createWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'salary_run.booked',
          webhook_url: 'https://example.com/hooks',
          name: 'payroll',
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(body.error.details.required_scope).toBe('payroll:read')
  })

  it('returns 401 UNAUTHORIZED when no Bearer token is supplied', async () => {
    const req = new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'invoice.paid',
        webhook_url: 'https://example.com/hooks',
        name: 'CRM',
      }),
    })

    const res = await createWebhook(req, companyParams(COMPANY_ID))
    expect(res.status).toBe(401)
  })
})

// ──────────────────────────────────────────────────────────────────────
// GET /webhooks  (list)
// ──────────────────────────────────────────────────────────────────────

describe('GET /api/v1/companies/:companyId/webhooks', () => {
  it('lists webhooks for the company without exposing secrets', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: [SAMPLE_WEBHOOK], error: null },
      }),
    )

    const res = await listWebhooks(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.webhooks).toHaveLength(1)
    expect(body.data.webhooks[0].id).toBe(WEBHOOK_ID)
    // Secret MUST never be in a list response: surfaced only on create.
    expect(body.data.webhooks[0]).not.toHaveProperty('secret')
  })

  it('returns an empty list when no webhooks are registered', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: [], error: null },
      }),
    )

    const res = await listWebhooks(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.webhooks).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────
// GET /webhooks/:id  (detail)
// ──────────────────────────────────────────────────────────────────────

describe('GET /api/v1/companies/:companyId/webhooks/:id', () => {
  it('returns the webhook detail without secret', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: SAMPLE_WEBHOOK, error: null },
      }),
    )

    const res = await getWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}`),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(WEBHOOK_ID)
    expect(body.data).not.toHaveProperty('secret')
  })

  it('returns 404 NOT_FOUND when the webhook does not exist for this company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: null, error: null },
      }),
    )

    const res = await getWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}`),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

// ──────────────────────────────────────────────────────────────────────
// PATCH /webhooks/:id  (update)
// ──────────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/companies/:companyId/webhooks/:id', () => {
  it('updates the webhook and clears disabled_at when active=true', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: {
          data: { ...SAMPLE_WEBHOOK, disabled_at: null, disabled_reason: null },
          error: null,
        },
      }),
    )

    const res = await updateWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      }),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.disabled_at).toBeNull()
    expect(body.data.disabled_reason).toBeNull()
  })

  it('re-runs the SSRF guard when webhook_url is changed', async () => {
    mockUrlGuard.mockResolvedValueOnce({
      ok: false,
      reason: 'metadata_address',
      detail: '169.254.169.254 is the cloud metadata endpoint',
    })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: 'https://metadata.example/hooks' }),
      }),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.reason).toBe('metadata_address')
  })

  it('returns 400 VALIDATION_ERROR for an empty body (no fields to update)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

// ──────────────────────────────────────────────────────────────────────
// DELETE /webhooks/:id
// ──────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/companies/:companyId/webhooks/:id', () => {
  it('returns 204 NO_CONTENT after a successful delete', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: null, error: null },
      }),
    )

    const res = await deleteWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(204)
  })
})

// ──────────────────────────────────────────────────────────────────────
// POST /webhooks/:id/test  (synthetic delivery)
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/v1/companies/:companyId/webhooks/:id/test', () => {
  it('enqueues a synthetic delivery and returns its id', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: {
          data: { id: WEBHOOK_ID, api_version_pinned: '2026-05-12', active: true, disabled_at: null },
          error: null,
        },
        webhook_deliveries: { data: { id: DELIVERY_ID }, error: null },
      }),
    )

    const res = await testWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/test`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.webhook_delivery_id).toBe(DELIVERY_ID)
    expect(body.data.status).toBe('pending')
  })

  it('returns 404 NOT_FOUND when the webhook does not exist', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: null, error: null },
      }),
    )

    const res = await testWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/test`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(404)
  })

  it('refuses to enqueue a test for a disabled webhook', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: {
          data: {
            id: WEBHOOK_ID,
            api_version_pinned: '2026-05-12',
            active: false,
            disabled_at: '2026-05-15T11:00:00Z',
          },
          error: null,
        },
      }),
    )

    const res = await testWebhook(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/test`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

// ──────────────────────────────────────────────────────────────────────
// GET /webhooks/:id/deliveries  (list deliveries)
// ──────────────────────────────────────────────────────────────────────

describe('GET /api/v1/companies/:companyId/webhooks/:id/deliveries', () => {
  it('returns deliveries for the webhook with status + response details', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: { id: WEBHOOK_ID }, error: null },
        webhook_deliveries: {
          data: [
            {
              id: DELIVERY_ID,
              webhook_id: WEBHOOK_ID,
              event_type: 'invoice.paid',
              status: 'delivered',
              attempts: 1,
              next_attempt_at: '2026-05-15T12:00:00Z',
              response_status: 200,
              response_body: 'ok',
              error: null,
              request_id: 'whfan_x',
              created_at: '2026-05-15T12:00:00Z',
              delivered_at: '2026-05-15T12:00:01Z',
            },
          ],
          error: null,
        },
      }),
    )

    const res = await listDeliveries(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/deliveries`,
      ),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(DELIVERY_ID)
    expect(body.data[0].status).toBe('delivered')
    expect(body.data[0].response_status).toBe(200)
  })

  it('returns 404 NOT_FOUND when the webhook does not exist for this company (clean signal vs empty list)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: null, error: null },
      }),
    )

    const res = await listDeliveries(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/deliveries`,
      ),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(404)
  })
})

// ──────────────────────────────────────────────────────────────────────
// POST /webhooks/:id/rotate-secret
// ──────────────────────────────────────────────────────────────────────

describe('POST /api/v1/companies/:companyId/webhooks/:id/rotate-secret', () => {
  it('returns a freshly-minted secret EXACTLY ONCE on rotation', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: { id: WEBHOOK_ID, name: 'CRM sync' }, error: null },
      }),
    )

    const res = await rotateSecret(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/rotate-secret`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(WEBHOOK_ID)
    expect(typeof body.data.secret).toBe('string')
    expect(body.data.secret).toMatch(/^whsec_/)
    expect(body.data.rotated_at).toBeTruthy()
  })

  it('returns 404 NOT_FOUND when the webhook does not exist for this company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        webhooks: { data: null, error: null },
      }),
    )

    const res = await rotateSecret(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/rotate-secret`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, WEBHOOK_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 401 UNAUTHORIZED when no Bearer token is supplied', async () => {
    const req = new Request(
      `https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/rotate-secret`,
      { method: 'POST' },
    )

    const res = await rotateSecret(req, detailParams(COMPANY_ID, WEBHOOK_ID))
    expect(res.status).toBe(401)
  })

  it('requires an Idempotency-Key header (write endpoint)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    // Build request WITHOUT the Idempotency-Key header (default makeRequest adds it).
    const req = new Request(
      `https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/rotate-secret`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
      },
    )

    const res = await rotateSecret(req, detailParams(COMPANY_ID, WEBHOOK_ID))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

// ──────────────────────────────────────────────────────────────────────
// Cross-tenant URL guard (wrapper level)
// ──────────────────────────────────────────────────────────────────────

describe('webhook routes: cross-tenant URL guard', () => {
  it('returns 404 NOT_FOUND when the caller is not a member of the company in the URL', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        // No membership row → wrapper short-circuits to NOT_FOUND.
        company_members: { data: null, error: null },
      }),
    )

    const res = await listWebhooks(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
