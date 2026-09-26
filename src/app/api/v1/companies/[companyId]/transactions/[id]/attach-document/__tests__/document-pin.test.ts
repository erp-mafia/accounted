/**
 * Pinning a document to a bank transaction, and taking it off, through the
 * v1 door of the operation registry (src/lib/operations/documents.ts):
 *   POST /api/v1/companies/:companyId/transactions/:id/attach-document
 *   POST /api/v1/companies/:companyId/transactions/:id/detach-document
 *
 * The rules are lib/transactions/document-attach.ts's, the same the dashboard
 * route and the MCP approval run: company ownership of both rows, never
 * replacing or detaching räkenskapsinformation, never another verifikat's
 * underlag, and a dry run that writes nothing.
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
import { POST as attach } from '../route'
import { POST as detach } from '../../detach-document/route'

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
const BOOKS = new Set(['document_attachments', 'transactions', 'invoice_inbox_items', 'processing_history'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OLD_DOC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}`

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

const txParams = (id = TX_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:read', 'transactions:write'],
    mode: 'live',
  })
})

describe('POST /transactions/:id/attach-document', () => {
  const post = (body: unknown, query = '', id = TX_ID) =>
    attach(request(`${BASE}/attach-document${query}`, { method: 'POST', body: JSON.stringify(body) }), txParams(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ document_id: DOC_ID })).status).toBe(401)
  })

  it('403 without transactions:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post({ document_id: DOC_ID })).status).toBe(403)
  })

  it('400 without a document_id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await post({})
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 for a transaction outside the company, and for a document outside it', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, transactions: { data: null, error: null } }))
    const noTx = await post({ document_id: DOC_ID })
    expect(noTx.status).toBe(404)
    expect((await noTx.json()).error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')

    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: { id: TX_ID, document_id: null, journal_entry_id: null }, error: null },
      document_attachments: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const noDoc = await post({ document_id: DOC_ID })
    expect(noDoc.status).toBe(404)
    expect((await noDoc.json()).error.code).toBe('DOC_NOT_FOUND')
    expect(wrote(client)).toBe(false)
  })

  it('409 DOC_ATTACH_REPLACES_POSTED when the pinned document is already räkenskapsinformation', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: { id: TX_ID, document_id: OLD_DOC_ID, journal_entry_id: JE_ID }, error: null },
      document_attachments: { data: { journal_entry_id: JE_ID }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ document_id: DOC_ID })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DOC_ATTACH_REPLACES_POSTED')
    expect(wrote(client)).toBe(false)
  })

  it('409 DOC_ATTACH_OTHER_VERIFIKAT when the document is another verifikat\'s underlag', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: { id: TX_ID, document_id: null, journal_entry_id: null }, error: null },
      document_attachments: { data: { id: DOC_ID, file_name: 'k.pdf', journal_entry_id: JE_ID }, error: null },
      transaction_voucher_links: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ document_id: DOC_ID })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DOC_ATTACH_OTHER_VERIFIKAT')
    expect(wrote(client)).toBe(false)
  })

  it('a dry run previews the pin and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: { id: TX_ID, document_id: null, journal_entry_id: JE_ID }, error: null },
      document_attachments: { data: { id: DOC_ID, file_name: 'k.pdf', journal_entry_id: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ document_id: DOC_ID }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      transaction_id: TX_ID,
      document_id: DOC_ID,
      replaces_document: false,
      transaction_booked: true,
    })
    expect(wrote(client)).toBe(false)
  })

  it('pins the document and propagates it onto the verifikat of a booked transaction', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: [
        { data: { id: TX_ID, document_id: null, journal_entry_id: JE_ID }, error: null },
        { data: { journal_entry_id: JE_ID }, error: null },
        { data: { document_id: DOC_ID }, error: null },
      ],
      document_attachments: [
        { data: { id: DOC_ID, file_name: 'k.pdf', journal_entry_id: null }, error: null },
        { data: null, error: null },
      ],
      invoice_inbox_items: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ document_id: DOC_ID })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      transaction_id: TX_ID,
      document_id: DOC_ID,
      previous_document_id: null,
      journal_entry_id: JE_ID,
    })
    const docUpdate = client.calls.find((c) => c.table === 'document_attachments' && c.method === 'update')
    expect(docUpdate?.args[0]).toEqual({ journal_entry_id: JE_ID })
    const txUpdate = client.calls.find((c) => c.table === 'transactions' && c.method === 'update')
    expect(txUpdate?.args[0]).toEqual({ document_id: DOC_ID })
  })
})

describe('POST /transactions/:id/detach-document', () => {
  const post = (query = '', id = TX_ID) =>
    detach(request(`${BASE}/detach-document${query}`, { method: 'POST' }), txParams(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post()).status).toBe(401)
  })

  it('403 without transactions:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post()).status).toBe(403)
  })

  it('400 on a non-UUID transaction id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post('', 'nope')).status).toBe(400)
  })

  it('404 for a transaction outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, transactions: { data: null, error: null } }))
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('409 DOC_DETACH_POSTED once the document is linked to a verifikat, writing nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: { id: TX_ID, document_id: DOC_ID }, error: null },
      document_attachments: { data: { journal_entry_id: JE_ID }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DOC_DETACH_POSTED')
    expect(wrote(client)).toBe(false)
  })

  it('a dry run names the inbox items it would release and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: { id: TX_ID, document_id: DOC_ID }, error: null },
      document_attachments: { data: { journal_entry_id: null }, error: null },
      invoice_inbox_items: { data: [{ id: '11111111-1111-4111-8111-111111111111' }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toEqual({
      transaction_id: TX_ID,
      document_id: DOC_ID,
      would_detach: true,
      released_inbox_item_ids: ['11111111-1111-4111-8111-111111111111'],
    })
    expect(wrote(client)).toBe(false)
  })

  it('releases the inbox back-link, then clears the pin with a compare-and-set', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: [
        { data: { id: TX_ID, document_id: DOC_ID }, error: null },
        { data: { id: TX_ID }, error: null },
      ],
      document_attachments: { data: { journal_entry_id: null }, error: null },
      invoice_inbox_items: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ transaction_id: TX_ID, document_id: null, detached_document_id: DOC_ID })
    const order = client.calls.filter((c) => c.method === 'update').map((c) => c.table)
    expect(order).toEqual(['invoice_inbox_items', 'transactions'])
    expect(client.calls).toContainEqual(expect.objectContaining({ table: 'transactions', method: 'eq', args: ['document_id', DOC_ID] }))
  })

  it('409 DOC_DETACH_CONCURRENT when the pin changed under the detach', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: [
        { data: { id: TX_ID, document_id: DOC_ID }, error: null },
        { data: null, error: null },
      ],
      document_attachments: { data: { journal_entry_id: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DOC_DETACH_CONCURRENT')
  })
})
