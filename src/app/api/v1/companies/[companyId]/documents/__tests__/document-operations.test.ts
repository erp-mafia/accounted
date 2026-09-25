/**
 * Document reads and delete through the v1 door of the operation registry
 * (src/lib/operations/documents.ts via lib/operations/v1.ts):
 *   GET    /api/v1/companies/:companyId/documents
 *   GET    /api/v1/companies/:companyId/documents/:id
 *   DELETE /api/v1/companies/:companyId/documents/:id
 *
 * The rule under test is the service's (lib/documents/document-actions.ts):
 * a document linked to a verifikat is räkenskapsinformation (BFL 7 kap 2 §)
 * and is never deleted, and a dry run writes nothing.
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listDocuments } from '../route'
import { GET as getDocument, DELETE as deleteDocument } from '../[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/** Per-table queue mock that also records every (table, method, args). */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(key)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  const rpc = vi.fn((...args: unknown[]) => {
    calls.push({ table: 'rpc', method: 'rpc', args })
    return buildChain('rpc')
  })
  const storage = { from: vi.fn(() => buildChain('storage')) }
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc, storage }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete', 'remove'])
/** Business tables only: withApiV1's own bookkeeping (idempotency, usage) is not the operation's. */
const BOOKS = new Set(['document_attachments', 'storage', 'transactions', 'invoice_inbox_items'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const TX_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/documents`

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const docParams = (id = DOC_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

function docRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    file_name: 'kvitto.pdf',
    mime_type: 'application/pdf',
    file_size_bytes: 1234,
    sha256_hash: 'abc',
    version: 1,
    is_current_version: true,
    upload_source: 'email',
    journal_entry_id: null,
    journal_entry_line_id: null,
    created_at: '2026-09-02T07:41:10.000Z',
    storage_path: 'documents/u/kvitto.pdf',
    user_id: 'user-1',
    original_id: null,
    superseded_by_id: null,
    digitization_date: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['documents:read', 'documents:write'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/documents', () => {
  const get = (query = '') => listDocuments(request(`${BASE}${query}`, { method: 'GET' }), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await get()).status).toBe(401)
  })

  it('403 without documents:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await get()).status).toBe(403)
  })

  it('400 on a malformed date filter', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await get('?uploaded_from=2026-9-1')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('pages newest first with a cursor, filters unlinked, and returns metadata only', async () => {
    const rows = [docRow(), docRow({ id: '11111111-1111-4111-8111-111111111111', created_at: '2026-09-01T07:00:00.000Z' })]
    const client = makeClient({ company_members: MEMBER, document_attachments: { data: rows, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await get('?linked=false&limit=1&uploaded_from=2026-09-01&uploaded_to=2026-09-30')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.documents).toHaveLength(1)
    expect(body.data.documents[0]).toMatchObject({ document_id: DOC_ID, linked: false, file_name: 'kvitto.pdf' })
    expect(body.data.documents[0].storage_path).toBeUndefined()
    expect(body.data.next_cursor).toEqual(expect.any(String))
    const docCalls = client.calls.filter((c) => c.table === 'document_attachments')
    expect(docCalls).toContainEqual(expect.objectContaining({ method: 'eq', args: ['company_id', COMPANY_ID] }))
    expect(docCalls).toContainEqual(expect.objectContaining({ method: 'is', args: ['journal_entry_id', null] }))
    expect(docCalls).toContainEqual(expect.objectContaining({ method: 'eq', args: ['is_current_version', true] }))
    expect(docCalls).toContainEqual(expect.objectContaining({ method: 'lt', args: ['created_at', '2026-10-01T00:00:00Z'] }))
  })
})

describe('GET /api/v1/companies/:companyId/documents/:id', () => {
  const get = (id = DOC_ID) => getDocument(request(`${BASE}/${id}`, { method: 'GET' }), docParams(id))

  it('400 on a non-UUID id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await get('nope')).status).toBe(400)
  })

  it('404 DOC_NOT_FOUND for a document outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, document_attachments: { data: null, error: null } }))
    const res = await get()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('DOC_NOT_FOUND')
  })

  it('answers metadata with the transactions and inbox item that hold it', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        document_attachments: { data: docRow({ journal_entry_id: JE_ID }), error: null },
        transactions: { data: [{ id: TX_ID }], error: null },
        invoice_inbox_items: { data: [{ id: '22222222-2222-4222-8222-222222222222' }], error: null },
      }),
    )
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      document_id: DOC_ID,
      linked: true,
      journal_entry_id: JE_ID,
      transaction_ids: [TX_ID],
      inbox_item_id: '22222222-2222-4222-8222-222222222222',
    })
  })
})

describe('DELETE /api/v1/companies/:companyId/documents/:id', () => {
  const del = (query = '', id = DOC_ID) =>
    deleteDocument(request(`${BASE}/${id}${query}`, { method: 'DELETE' }), docParams(id))

  it('403 without documents:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['documents:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await del()).status).toBe(403)
  })

  it('400 on a non-UUID id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await del('', 'nope')).status).toBe(400)
  })

  it('404 DOC_NOT_FOUND for a document outside the company', async () => {
    const client = makeClient({ company_members: MEMBER, document_attachments: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('DOC_NOT_FOUND')
    expect(wrote(client)).toBe(false)
  })

  it('409 DOC_DELETE_LINKED for a document linked to a verifikat (BFL 7 kap 2 §), writing nothing', async () => {
    const client = makeClient({ company_members: MEMBER, document_attachments: { data: docRow({ journal_entry_id: JE_ID }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('DOC_DELETE_LINKED')
    expect(wrote(client)).toBe(false)
  })

  it('the dry run applies the same rule and writes nothing', async () => {
    const linked = makeClient({ company_members: MEMBER, document_attachments: { data: docRow({ journal_entry_id: JE_ID }), error: null } })
    mockServiceClient.mockReturnValue(linked)
    expect((await del('?dry_run=true')).status).toBe(409)

    const free = makeClient({ company_members: MEMBER, document_attachments: { data: docRow(), error: null } })
    mockServiceClient.mockReturnValue(free)
    const res = await del('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toEqual({ document_id: DOC_ID, file_name: 'kvitto.pdf', would_delete: true })
    expect(wrote(free)).toBe(false)
  })

  it('deletes an unlinked document and its stored file', async () => {
    const client = makeClient({
      company_members: MEMBER,
      document_attachments: [{ data: docRow(), error: null }, { data: null, error: null }],
      storage: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ document_id: DOC_ID, deleted: true })
    expect(client.calls).toContainEqual(expect.objectContaining({ table: 'document_attachments', method: 'delete' }))
    expect(client.calls).toContainEqual(expect.objectContaining({ table: 'storage', method: 'remove' }))
  })
})
