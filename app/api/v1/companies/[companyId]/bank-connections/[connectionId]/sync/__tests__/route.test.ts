/**
 * Tests for POST /api/v1/companies/{companyId}/bank-connections/{connectionId}/sync.
 *
 * Exercises the real withApiV1 wrapper (auth, scope, company membership,
 * idempotency header) with the Supabase client and the sync runner mocked.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
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
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const { requireCapabilityMock, triggerSyncMock } = vi.hoisted(() => ({
  requireCapabilityMock: vi.fn(),
  triggerSyncMock: vi.fn(),
}))
vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: requireCapabilityMock,
}))
vi.mock('@/extensions/general/enable-banking/lib/trigger-sync', () => ({
  SYNC_COOLDOWN_MS: 15 * 60 * 1000,
  triggerConnectionSync: triggerSyncMock,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
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
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
const BASE = `http://localhost/api/v1/companies/${COMPANY_ID}/bank-connections/${CONNECTION_ID}/sync`

function req(opts: { idempotencyKey?: string | null; dryRun?: boolean } = {}): Request {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-fixture-not-a-real-key',
    'Content-Type': 'application/json',
  }
  if (opts.idempotencyKey !== null) headers['Idempotency-Key'] = opts.idempotencyKey ?? 'idem-1'
  const url = opts.dryRun ? `${BASE}?dry_run=true` : BASE
  return new Request(url, { method: 'POST', headers, body: '{}' })
}

function authOk(scopes: string[], mode: 'live' | 'test' = 'live') {
  mockValidate.mockResolvedValue({
    valid: true,
    userId: 'user-1',
    keyId: 'key-1',
    keyName: 'Test key',
    scopes,
    mode,
  })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID, connectionId: CONNECTION_ID }) }

const OK_RESULT = {
  ok: true,
  connection_id: CONNECTION_ID,
  bank: 'Swedbank',
  imported: 3,
  duplicates: 12,
  from_date: '2026-08-26',
  to_date: '2026-09-02',
  last_synced_at: '2026-09-02T09:14:03.000Z',
}

describe('v1 bank-connections sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireCapabilityMock.mockResolvedValue(null)
    triggerSyncMock.mockResolvedValue(OK_RESULT)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { role: 'owner' } },
        idempotency_keys: { data: null },
      }),
    )
  })

  it('401 without a valid key', async () => {
    mockValidate.mockResolvedValue({ valid: false, error: 'invalid' })
    const res = await POST(req(), params)
    expect(res.status).toBe(401)
    expect(triggerSyncMock).not.toHaveBeenCalled()
  })

  it('403 INSUFFICIENT_SCOPE when the key lacks transactions:write', async () => {
    authOk(['transactions:read', 'companies:read'])
    const res = await POST(req(), params)
    expect(res.status).toBe(403)
    expect(triggerSyncMock).not.toHaveBeenCalled()
  })

  it('returns the capability-blocked response when bank_sync is not entitled', async () => {
    authOk(['transactions:write'])
    requireCapabilityMock.mockResolvedValue(
      Response.json({ error: { code: 'CAPABILITY_BLOCKED' } }, { status: 403 }),
    )
    const res = await POST(req(), params)
    expect(res.status).toBe(403)
    expect(requireCapabilityMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'bank_sync')
    expect(triggerSyncMock).not.toHaveBeenCalled()
  })

  it('404 when the key user is not a member of the company', async () => {
    authOk(['transactions:write'])
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: { data: null } }))
    const res = await POST(req(), params)
    expect(res.status).toBe(404)
    expect(triggerSyncMock).not.toHaveBeenCalled()
  })

  it('blocks a test key: the bank call cannot be simulated', async () => {
    authOk(['transactions:write'], 'test')
    const res = await POST(req(), params)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(triggerSyncMock).not.toHaveBeenCalled()
  })

  it('refuses ?dry_run=true on a live key with a VALIDATION_ERROR', async () => {
    authOk(['transactions:write'])
    const res = await POST(req({ dryRun: true }), params)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details: { field: string } } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('dry_run')
    expect(triggerSyncMock).not.toHaveBeenCalled()
  })

  it('runs the sync for the path connection and returns the outcome', async () => {
    authOk(['transactions:write'])
    const res = await POST(req(), params)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Record<string, unknown>
      meta: { request_id: string }
    }
    expect(triggerSyncMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId: COMPANY_ID, userId: 'user-1', connectionId: CONNECTION_ID }),
    )
    expect(body.data).toEqual({
      connection_id: CONNECTION_ID,
      bank: 'Swedbank',
      imported: 3,
      duplicates: 12,
      from_date: '2026-08-26',
      to_date: '2026-09-02',
      last_synced_at: '2026-09-02T09:14:03.000Z',
    })
    expect(body.meta.request_id).toMatch(/^req_/)
  })

  it('429 BANK_SYNC_COOLDOWN with next_allowed_at and Retry-After', async () => {
    authOk(['transactions:write'])
    triggerSyncMock.mockResolvedValue({
      ok: false,
      code: 'BANK_SYNC_COOLDOWN',
      connection_id: CONNECTION_ID,
      next_allowed_at: '2026-09-02T09:29:03.000Z',
      retry_after_seconds: 600,
    })
    const res = await POST(req(), params)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('600')
    const body = (await res.json()) as {
      error: { code: string; details: { next_allowed_at: string } }
    }
    expect(body.error.code).toBe('BANK_SYNC_COOLDOWN')
    expect(body.error.details.next_allowed_at).toBe('2026-09-02T09:29:03.000Z')
  })

  it('409 BANK_SESSION_EXPIRED with a recovery hint pointing at the connect link', async () => {
    authOk(['transactions:write'])
    triggerSyncMock.mockResolvedValue({
      ok: false,
      code: 'BANK_SESSION_EXPIRED',
      connection_id: CONNECTION_ID,
      status: 'expired',
    })
    const res = await POST(req(), params)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; recovery_hint?: string } }
    expect(body.error.code).toBe('BANK_SESSION_EXPIRED')
    expect(body.error.recovery_hint).toContain('connect_url')
  })

  it('404 NOT_FOUND for a connection outside the company', async () => {
    authOk(['transactions:write'])
    triggerSyncMock.mockResolvedValue({ ok: false, code: 'NOT_FOUND', connection_id: CONNECTION_ID })
    const res = await POST(req(), params)
    expect(res.status).toBe(404)
  })

  it('maps a thrown database error into the v1 error envelope', async () => {
    authOk(['transactions:write'])
    triggerSyncMock.mockRejectedValue({ message: 'boom', code: '57014' })
    const res = await POST(req(), params)
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBeTruthy()
  })
})
