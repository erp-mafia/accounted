/**
 * Tests for the v1 ignore verb (issue #1661):
 *
 * POST   /api/v1/companies/{companyId}/transactions/{id}/ignore
 * DELETE /api/v1/companies/{companyId}/transactions/{id}/ignore
 *
 * Proxy-backed Supabase mock with per-table response queues (same pattern as
 * the sibling categorize route test). The booked check is the shared core's
 * (lib/transactions/ignore.ts): a junction-anchored row with journal_entry_id
 * NULL must be refused like a directly booked one.
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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST, DELETE } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const updates: Record<string, unknown[]> = {}
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
        return (...args: unknown[]) => {
          if (prop === 'update') (updates[table] ??= []).push(args[0])
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { supabase: { from: vi.fn((table: string) => buildChain(table)) }, updates }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/ignore`

function makeRequest(method: 'POST' | 'DELETE', opts: { url?: string; idempotencyKey?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-fixture-not-a-real-key',
  }
  if (opts.idempotencyKey !== null) {
    headers['Idempotency-Key'] = opts.idempotencyKey ?? 'idem1234-aaaa-4abc-8def-1234567890ab'
  }
  return new Request(opts.url ?? URL, { method, headers })
}
function routeParams(id: string = TX_ID) {
  return { params: Promise.resolve({ companyId: COMPANY_ID, id }) }
}

function unbookedSupabase(transactionOverrides: Record<string, unknown> = {}) {
  return makeFlexibleSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    transactions: [
      { data: { id: TX_ID, journal_entry_id: null, is_ignored: false, ...transactionOverrides }, error: null },
      { data: null, error: null }, // update
    ],
    transaction_voucher_links: { data: [], error: null },
    invoice_payments: { data: [], error: null },
    supplier_invoice_payments: { data: [], error: null },
    idempotency_keys: { data: null, error: null },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/.../transactions/{id}/ignore', () => {
  it('returns 401 without a valid bearer token', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(unbookedSupabase().supabase)

    const res = await POST(makeRequest('POST'), routeParams())
    expect(res.status).toBe(401)
  })

  it('rejects keys without transactions:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      scopes: ['transactions:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(unbookedSupabase().supabase)

    const res = await POST(makeRequest('POST'), routeParams())
    expect(res.status).toBe(403)
  })

  it('requires an Idempotency-Key (400)', async () => {
    const { supabase, updates } = unbookedSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest('POST', { idempotencyKey: null }), routeParams())
    expect(res.status).toBe(400)
    expect(updates.transactions).toBeUndefined()
  })

  it('rejects a non-UUID transaction id with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(unbookedSupabase().supabase)

    const res = await POST(
      makeRequest('POST', { url: `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/not-a-uuid/ignore` }),
      routeParams('not-a-uuid'),
    )
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 TX_CATEGORIZE_TX_NOT_FOUND when the row is not in this company', async () => {
    const { supabase, updates } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest('POST'), routeParams())
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
    expect(updates.transactions).toBeUndefined()
  })

  it('returns 409 TX_IGNORE_ALREADY_BOOKED for a directly booked row', async () => {
    const { supabase, updates } = unbookedSupabase({ journal_entry_id: 'je-1' })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest('POST'), routeParams())
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('TX_IGNORE_ALREADY_BOOKED')
    expect(body.error.details.transaction_id).toBe(TX_ID)
    expect(updates.transactions).toBeUndefined()
  })

  it('returns 409 for a bulk-booked row anchored only through transaction_voucher_links', async () => {
    const { supabase, updates } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: { id: TX_ID, journal_entry_id: null, is_ignored: false }, error: null },
      transaction_voucher_links: { data: [{ transaction_id: TX_ID }], error: null },
      invoice_payments: { data: [], error: null },
      supplier_invoice_payments: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest('POST'), routeParams())
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('TX_IGNORE_ALREADY_BOOKED')
    expect(updates.transactions).toBeUndefined()
  })

  it('returns 409 for a multi-allocated row anchored only through invoice_payments', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: { id: TX_ID, journal_entry_id: null, is_ignored: false }, error: null },
      transaction_voucher_links: { data: [], error: null },
      invoice_payments: { data: [{ transaction_id: TX_ID }], error: null },
      supplier_invoice_payments: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest('POST'), routeParams())
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('TX_IGNORE_ALREADY_BOOKED')
  })

  it('is idempotent: an already-ignored row returns already_ignored=true without writing', async () => {
    const { supabase, updates } = unbookedSupabase({ is_ignored: true })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest('POST'), routeParams())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual({
      success: true,
      transaction_id: TX_ID,
      is_ignored: true,
      already_ignored: true,
    })
    expect(updates.transactions).toBeUndefined()
  })

  it('ignores an unbooked row (happy path)', async () => {
    const { supabase, updates } = unbookedSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest('POST'), routeParams())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual({
      success: true,
      transaction_id: TX_ID,
      is_ignored: true,
      already_ignored: false,
    })
    expect(updates.transactions).toEqual([{ is_ignored: true }])
  })

  it('dry-run previews without writing', async () => {
    const { supabase, updates } = unbookedSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest('POST', { url: `${URL}?dry_run=true` }), routeParams())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toEqual({
      transaction_id: TX_ID,
      would_set_ignored: true,
      already_ignored: false,
    })
    expect(updates.transactions).toBeUndefined()
  })
})

describe('DELETE /api/v1/.../transactions/{id}/ignore', () => {
  it('returns 401 without a valid bearer token', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(unbookedSupabase().supabase)

    const res = await DELETE(makeRequest('DELETE'), routeParams())
    expect(res.status).toBe(401)
  })

  it('returns 404 when the row is not in this company', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await DELETE(makeRequest('DELETE'), routeParams())
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('restores an ignored row (happy path)', async () => {
    const { supabase, updates } = unbookedSupabase({ is_ignored: true })
    mockServiceClient.mockReturnValue(supabase)

    const res = await DELETE(makeRequest('DELETE'), routeParams())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual({
      success: true,
      transaction_id: TX_ID,
      is_ignored: false,
      was_ignored: true,
    })
    expect(updates.transactions).toEqual([{ is_ignored: false }])
  })

  it('is idempotent: restoring a row that is not ignored returns was_ignored=false without writing', async () => {
    const { supabase, updates } = unbookedSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await DELETE(makeRequest('DELETE'), routeParams())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.was_ignored).toBe(false)
    expect(updates.transactions).toBeUndefined()
  })
})
