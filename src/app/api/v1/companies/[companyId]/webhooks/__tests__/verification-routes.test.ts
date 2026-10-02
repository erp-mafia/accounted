/**
 * v1 surface of the endpoint ownership handshake (ADA CASA 7.1.2, #3191):
 *
 *   POST /webhooks/:id/verify   the manual handshake (401 / 404 / 400 / 429 /
 *                               422 / 200)
 *   GET, PATCH /webhooks/:id    verification_status derived and returned; a
 *                               URL change reads back as 'pending'
 *   POST /webhooks/:id/test     refused for endpoints that may not receive
 *   POST /webhook-deliveries/:id/retry   events (409 WEBHOOK_NOT_VERIFIED)
 *
 * The handshake itself (contract, conditional writes, cooldown) is covered in
 * lib/webhooks/__tests__/verification.test.ts; here the service is mocked and
 * the door's outcome-to-HTTP mapping is what is under test.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/webhooks/url-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/webhooks/url-guard')>('@/lib/webhooks/url-guard')
  return { ...actual, validateWebhookUrl: vi.fn() }
})
vi.mock('@/lib/webhooks/verification', async () => {
  const actual = await vi.importActual<typeof import('@/lib/webhooks/verification')>(
    '@/lib/webhooks/verification',
  )
  return { ...actual, verifyWebhookNow: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { validateWebhookUrl } from '@/lib/webhooks/url-guard'
import { verifyWebhookNow } from '@/lib/webhooks/verification'
import { POST as verifyWebhook } from '../[id]/verify/route'
import { GET as getWebhook, PATCH as updateWebhook } from '../[id]/route'
import { GET as listWebhooks } from '../route'
import { POST as testWebhook } from '../[id]/test/route'
import { POST as retryDelivery } from '../../../../webhook-deliveries/[id]/retry/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockUrlGuard = validateWebhookUrl as ReturnType<typeof vi.fn>
const mockVerifyNow = verifyWebhookNow as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const buildChain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(table)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return () => buildChain(table)
        },
      },
    )
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WEBHOOK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DELIVERY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FUTURE = new Date(Date.now() + 10 * 86400_000).toISOString()
const PAST = new Date(Date.now() - 86400_000).toISOString()

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://x.test/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ...(init?.headers ?? {}),
    },
  })
}
const params = (id = WEBHOOK_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })
const member = { company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null } }

const STATE = {
  id: WEBHOOK_ID,
  webhook_url: 'https://example.com/hooks',
  verified_at: null as string | null,
  verification_grace_ends_at: null as string | null,
  verification_attempts: 1,
  verification_last_attempt_at: '2026-10-01T10:00:00Z',
  verification_last_error: null as string | null,
  verification_next_attempt_at: null as string | null,
}

const FULL_WEBHOOK = {
  ...STATE,
  name: 'CRM sync',
  description: null,
  event_type: 'invoice.paid',
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
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['webhooks:manage', 'payroll:read'],
    mode: 'live',
  })
  mockUrlGuard.mockResolvedValue({ ok: true, hostname: 'example.com', resolvedAddresses: ['203.0.113.42'] })
})

describe('POST /api/v1/companies/:companyId/webhooks/:id/verify', () => {
  const call = () =>
    verifyWebhook(request(`/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/verify`, { method: 'POST' }), params())

  it('returns 401 without a bearer token and never runs the handshake', async () => {
    const res = await verifyWebhook(
      new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/verify`, { method: 'POST' }),
      params(),
    )
    expect(res.status).toBe(401)
    expect(mockVerifyNow).not.toHaveBeenCalled()
  })

  it('returns 200 with the verified state after a passing handshake', async () => {
    mockVerifyNow.mockResolvedValueOnce({ kind: 'verified' })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ ...member, webhooks: { data: { ...STATE, verified_at: '2026-10-01T10:00:01Z' } } }),
    )

    const res = await call()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ id: WEBHOOK_ID, verification_status: 'verified', verified_at: '2026-10-01T10:00:01Z' })
    expect(mockVerifyNow).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, webhookId: WEBHOOK_ID, actor: { userId: 'user-1', apiKeyId: 'ak_1' } }),
    )
  })

  it('returns 200 for an already verified webhook', async () => {
    mockVerifyNow.mockResolvedValueOnce({ kind: 'already_verified' })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ ...member, webhooks: { data: { ...STATE, verified_at: PAST } } }),
    )
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).data.verification_status).toBe('verified')
  })

  it('returns 422 WEBHOOK_VERIFICATION_FAILED with the reason and the recorded state', async () => {
    mockVerifyNow.mockResolvedValueOnce({ kind: 'failed', reason: 'challenge_mismatch', error: 'challenge_mismatch' })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ ...member, webhooks: { data: { ...STATE, verification_last_error: 'challenge_mismatch' } } }),
    )

    const res = await call()

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('WEBHOOK_VERIFICATION_FAILED')
    expect(body.error.details.reason).toBe('challenge_mismatch')
    expect(body.error.details.webhook).toMatchObject({ verification_status: 'pending', verification_last_error: 'challenge_mismatch' })
  })

  it('returns 404 for a webhook outside the company', async () => {
    mockVerifyNow.mockResolvedValueOnce({ kind: 'not_found' })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ ...member }))
    const res = await call()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
  })

  it('returns 400 for a disabled webhook', async () => {
    mockVerifyNow.mockResolvedValueOnce({ kind: 'disabled' })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ ...member }))
    const res = await call()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 429 with Retry-After inside the cooldown', async () => {
    mockVerifyNow.mockResolvedValueOnce({ kind: 'cooldown', retryAfterSeconds: 7 })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ ...member }))
    const res = await call()
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('7')
    expect((await res.json()).error.code).toBe('RATE_LIMITED')
  })

  it('returns 409 when the URL changed during the attempt', async () => {
    mockVerifyNow.mockResolvedValueOnce({ kind: 'superseded' })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ ...member }))
    const res = await call()
    expect(res.status).toBe(409)
  })
})

describe('verification state on the read and update surfaces', () => {
  it('derives grace_period, paused and pending on the list', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...member,
        webhooks: {
          data: [
            { ...FULL_WEBHOOK, id: 'a', verification_grace_ends_at: FUTURE },
            { ...FULL_WEBHOOK, id: 'b', verification_grace_ends_at: PAST },
            { ...FULL_WEBHOOK, id: 'c' },
          ],
        },
      }),
    )
    const res = await listWebhooks(request(`/companies/${COMPANY_ID}/webhooks`), {
      params: Promise.resolve({ companyId: COMPANY_ID }),
    })
    expect(res.status).toBe(200)
    const statuses = (await res.json()).data.webhooks.map((w: { verification_status: string }) => w.verification_status)
    expect(statuses).toEqual(['grace_period', 'paused', 'pending'])
  })

  it('returns verification_status on the detail read', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ ...member, webhooks: { data: { ...FULL_WEBHOOK, verified_at: PAST } } }),
    )
    const res = await getWebhook(request(`/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}`), params())
    expect((await res.json()).data.verification_status).toBe('verified')
  })

  it('reads back pending after a URL change (the database trigger resets verification)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...member,
        webhooks: [
          { data: { ...FULL_WEBHOOK, verified_at: PAST } }, // prior-state read
          { data: { ...FULL_WEBHOOK, webhook_url: 'https://new.example.com/hooks', verified_at: null } },
        ],
      }),
    )
    const res = await updateWebhook(
      request(`/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: 'https://new.example.com/hooks' }),
      }),
      params(),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.verification_status).toBe('pending')
  })

  it('previews the reset on a dry-run URL change', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ ...member }))
    const res = await updateWebhook(
      request(`/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}?dry_run=true`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: 'https://new.example.com/hooks' }),
      }),
      params(),
    )
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).toContain('"verification_status":"pending"')
  })
})

describe('event-sending verbs refuse endpoints that may not receive events', () => {
  it('POST /webhooks/:id/test answers 409 WEBHOOK_NOT_VERIFIED for a pending endpoint', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...member,
        webhooks: { data: { id: WEBHOOK_ID, api_version_pinned: '2026-05-12', active: true, disabled_at: null, verified_at: null, verification_grace_ends_at: null } },
      }),
    )
    const res = await testWebhook(request(`/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/test`, { method: 'POST' }), params())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('WEBHOOK_NOT_VERIFIED')
    expect(body.error.details.verification_status).toBe('pending')
  })

  it('POST /webhooks/:id/test still works for a legacy endpoint inside its grace window', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...member,
        webhooks: { data: { id: WEBHOOK_ID, api_version_pinned: '2026-05-12', active: true, disabled_at: null, verified_at: null, verification_grace_ends_at: FUTURE } },
        webhook_deliveries: { data: { id: DELIVERY_ID } },
      }),
    )
    const res = await testWebhook(request(`/companies/${COMPANY_ID}/webhooks/${WEBHOOK_ID}/test`, { method: 'POST' }), params())
    expect(res.status).toBe(200)
  })

  it('POST /webhook-deliveries/:id/retry answers 409 WEBHOOK_NOT_VERIFIED for a paused endpoint', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...member,
        webhook_deliveries: {
          data: {
            id: DELIVERY_ID,
            webhook_id: WEBHOOK_ID,
            company_id: COMPANY_ID,
            event_type: 'invoice.paid',
            payload: { id: 'inv-1' },
            previous_attributes: null,
            api_version: '2026-05-12',
            status: 'dead',
          },
        },
        webhooks: {
          data: { id: WEBHOOK_ID, webhook_url: 'https://example.com/hooks', active: true, disabled_at: null, verified_at: null, verification_grace_ends_at: PAST },
        },
      }),
    )
    const res = await retryDelivery(request(`/webhook-deliveries/${DELIVERY_ID}/retry`, { method: 'POST' }), {
      params: Promise.resolve({ id: DELIVERY_ID }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('WEBHOOK_NOT_VERIFIED')
    expect(body.error.details.verification_status).toBe('paused')
  })
})
