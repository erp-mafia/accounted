/**
 * Tests for POST /api/v1/companies/{companyId}/inbox-items/{id}/stamp through
 * the real withApiV1 wrapper (auth, scope, membership, idempotency) with the
 * Supabase client mocked per table.
 *
 * The 401 case is the regression guard: the route had no V1_ENDPOINT_SCOPES
 * entry, so the wrapper answered NOT_FOUND to every caller (valid key or not)
 * before this file existed.
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
const ITEM_ID = '22222222-2222-4222-8222-222222222222'
const JE_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_JE_ID = '55555555-5555-4555-8555-555555555555'
const url = (itemId = ITEM_ID) => `http://localhost/api/v1/companies/${COMPANY_ID}/inbox-items/${itemId}/stamp`

function req(init: { body?: unknown; idem?: boolean; itemId?: string; auth?: boolean } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.auth !== false) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  if (init.idem !== false) headers['Idempotency-Key'] = `idem-${Math.random().toString(36).slice(2)}-aaaa-4abc-8def-1234567890ab`
  return new Request(url(init.itemId), {
    method: 'POST',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
}

function authOk(scopes: string[]) {
  mockValidate.mockResolvedValue({ valid: true, userId: 'user-1', keyId: 'key-1', keyName: 'Test key', scopes, mode: 'live' })
}

const params = (id = ITEM_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

function withTables(tables: Record<string, MockResult | MockResult[]>) {
  mockServiceClient.mockReturnValue(
    makeFlexibleSupabase({
      company_members: { data: { role: 'owner' } },
      idempotency_keys: { data: null },
      ...tables,
    }),
  )
}

describe('POST /api/v1/companies/{companyId}/inbox-items/{id}/stamp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withTables({
      invoice_inbox_items: { data: { id: ITEM_ID, created_journal_entry_id: null } },
      journal_entries: { data: { id: JE_ID } },
    })
  })

  it('401 without a bearer token and 401 with an invalid key (not 404: the endpoint is registered)', async () => {
    mockValidate.mockResolvedValue({ valid: false, error: 'invalid' })
    const noAuth = await POST(req({ body: { journal_entry_id: JE_ID }, auth: false }), params())
    expect(noAuth.status).toBe(401)
    const badKey = await POST(req({ body: { journal_entry_id: JE_ID } }), params())
    expect(badKey.status).toBe(401)
    expect((await badKey.json()).error.code).not.toBe('NOT_FOUND')
  })

  it('403 without documents:write', async () => {
    authOk(['documents:read'])
    const res = await POST(req({ body: { journal_entry_id: JE_ID } }), params())
    expect(res.status).toBe(403)
  })

  it('400 without an Idempotency-Key, on a malformed body, and on a non-UUID item id', async () => {
    authOk(['documents:write'])
    expect((await POST(req({ body: { journal_entry_id: JE_ID }, idem: false }), params())).status).toBe(400)
    expect((await POST(req({ body: {} }), params())).status).toBe(400)
    expect((await POST(req({ body: { journal_entry_id: JE_ID, extra: 1 } }), params())).status).toBe(400)
    expect((await POST(req({ body: { journal_entry_id: JE_ID }, itemId: 'not-a-uuid' }), params('not-a-uuid'))).status).toBe(400)
  })

  it('404 when the inbox item or the journal entry is not in the company', async () => {
    authOk(['documents:write'])
    withTables({ invoice_inbox_items: { data: null }, journal_entries: { data: { id: JE_ID } } })
    const noItem = await POST(req({ body: { journal_entry_id: JE_ID } }), params())
    expect(noItem.status).toBe(404)
    expect((await noItem.json()).error.details.resource).toBe('inbox_item')

    withTables({ invoice_inbox_items: { data: { id: ITEM_ID, created_journal_entry_id: null } }, journal_entries: { data: null } })
    const noJe = await POST(req({ body: { journal_entry_id: JE_ID } }), params())
    expect(noJe.status).toBe(404)
    expect((await noJe.json()).error.details.resource).toBe('journal_entry')
  })

  it('stamps an unstamped item and returns the new link', async () => {
    authOk(['documents:write'])
    const res = await POST(req({ body: { journal_entry_id: JE_ID } }), params())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ id: ITEM_ID, created_journal_entry_id: JE_ID })
  })

  it('is idempotent when the item is already stamped with the same entry', async () => {
    authOk(['documents:write'])
    withTables({ invoice_inbox_items: { data: { id: ITEM_ID, created_journal_entry_id: JE_ID } }, journal_entries: { data: { id: JE_ID } } })
    const res = await POST(req({ body: { journal_entry_id: JE_ID } }), params())
    expect(res.status).toBe(200)
    expect((await res.json()).data.created_journal_entry_id).toBe(JE_ID)
  })

  it('409 when the item is already stamped with a different entry', async () => {
    authOk(['documents:write'])
    withTables({ invoice_inbox_items: { data: { id: ITEM_ID, created_journal_entry_id: OTHER_JE_ID } }, journal_entries: { data: { id: JE_ID } } })
    const res = await POST(req({ body: { journal_entry_id: JE_ID } }), params())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('CONFLICT')
    expect(body.error.details.current_journal_entry_id).toBe(OTHER_JE_ID)
  })
})
