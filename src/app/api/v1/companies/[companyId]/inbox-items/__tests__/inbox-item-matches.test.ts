/**
 * Inbox pairing through the v1 door of the operation registry
 * (src/lib/operations/inbox-matches.ts via lib/operations/v1.ts):
 *   POST /api/v1/companies/:companyId/inbox-items/:id/match-supplier
 *   POST /api/v1/companies/:companyId/inbox-items/:id/match-transaction
 *
 * The rules under test are lib/documents/inbox-match.ts's: the item and the
 * supplier / transaction must belong to the company (the service role skips
 * RLS), an existing transaction document is never replaced, and a dry run
 * writes nothing.
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
const completeMock = vi.fn()
vi.mock('@/lib/transactions/inbox-underlag', async () => {
  const actual = await vi.importActual<typeof import('@/lib/transactions/inbox-underlag')>('@/lib/transactions/inbox-underlag')
  return { ...actual, completeInboxItemsForBookedTransaction: (...args: unknown[]) => completeMock(...args) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as matchSupplier } from '../[id]/match-supplier/route'
import { POST as matchTransaction } from '../[id]/match-transaction/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

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
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc: vi.fn() }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const BOOKS = new Set(['invoice_inbox_items', 'transactions', 'document_attachments'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => BOOKS.has(c.table) && WRITES.has(c.method))

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ITEM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SUPPLIER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TX_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DOC_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/inbox-items/${ITEM_ID}`
const params = { params: Promise.resolve({ companyId: COMPANY_ID, id: ITEM_ID }) }

function request(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  completeMock.mockResolvedValue(null)
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['documents:write'],
    mode: 'live',
  })
})

describe('POST /inbox-items/:id/match-supplier', () => {
  const post = (body: unknown, query = '') => matchSupplier(request(`${BASE}/match-supplier${query}`, body), params)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ supplier_id: SUPPLIER_ID })).status).toBe(401)
  })

  it('403 without documents:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['documents:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ supplier_id: SUPPLIER_ID })).status).toBe(403)
  })

  it('400 VALIDATION_ERROR without a supplier_id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await post({})
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 SUPPLIER_NOT_FOUND for a supplier of another company, writing nothing', async () => {
    const client = makeClient({ company_members: OWNER, suppliers: { data: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ supplier_id: SUPPLIER_ID })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SUPPLIER_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'suppliers', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(wrote(client)).toBe(false)
  })

  it('404 INBOX_ITEM_NOT_FOUND for an item of another company', async () => {
    const client = makeClient({
      company_members: OWNER,
      suppliers: { data: { id: SUPPLIER_ID, name: 'Clas Ohlson AB' } },
      invoice_inbox_items: { data: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ supplier_id: SUPPLIER_ID })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INBOX_ITEM_NOT_FOUND')
    expect(wrote(client)).toBe(false)
  })

  it('a dry run previews the change and writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      suppliers: { data: { id: SUPPLIER_ID, name: 'Clas Ohlson AB' } },
      invoice_inbox_items: { data: { id: ITEM_ID, matched_supplier_id: null } },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ supplier_id: SUPPLIER_ID }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ supplier_name: 'Clas Ohlson AB', changed: true })
    expect(wrote(client)).toBe(false)
  })

  it('sets the matched supplier', async () => {
    const client = makeClient({
      company_members: OWNER,
      suppliers: { data: { id: SUPPLIER_ID, name: 'Clas Ohlson AB' } },
      invoice_inbox_items: { data: { id: ITEM_ID, matched_supplier_id: null } },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ supplier_id: SUPPLIER_ID })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ inbox_item_id: ITEM_ID, matched_supplier_id: SUPPLIER_ID })
    const update = client.calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'update')
    expect(update?.args[0]).toEqual({ matched_supplier_id: SUPPLIER_ID })
  })
})

describe('POST /inbox-items/:id/match-transaction', () => {
  const post = (body: unknown, query = '') => matchTransaction(request(`${BASE}/match-transaction${query}`, body), params)

  it('404 TX_CATEGORIZE_TX_NOT_FOUND for a transaction of another company', async () => {
    const client = makeClient({ company_members: OWNER, transactions: { data: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ transaction_id: TX_ID })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
    expect(wrote(client)).toBe(false)
  })

  it('404 INBOX_ITEM_NOT_FOUND for an unknown item', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: { data: { id: TX_ID, document_id: null } },
      invoice_inbox_items: { data: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ transaction_id: TX_ID })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it('a dry run writes nothing and never completes items against a verifikat', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: { data: { id: TX_ID, document_id: null } },
      invoice_inbox_items: { data: { id: ITEM_ID, document_id: DOC_ID } },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ transaction_id: TX_ID }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ pins_document_on_transaction: true, document_id: DOC_ID })
    expect(wrote(client)).toBe(false)
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('pairs the item and pins its document on a transaction that has none', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: { data: { id: TX_ID, document_id: null } },
      invoice_inbox_items: [
        { data: { id: ITEM_ID, document_id: DOC_ID } },
        { data: { id: ITEM_ID, matched_transaction_id: TX_ID } },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ transaction_id: TX_ID })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ inbox_item_id: ITEM_ID, matched_transaction_id: TX_ID })
    const txUpdate = client.calls.find((c) => c.table === 'transactions' && c.method === 'update')
    expect(txUpdate?.args[0]).toEqual({ document_id: DOC_ID })
    expect(completeMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, TX_ID)
  })

  it('never replaces a document the transaction already carries', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: { data: { id: TX_ID, document_id: 'other-doc' } },
      invoice_inbox_items: [
        { data: { id: ITEM_ID, document_id: DOC_ID } },
        { data: { id: ITEM_ID, matched_transaction_id: TX_ID } },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ transaction_id: TX_ID })
    expect(res.status).toBe(200)
    expect(client.calls.some((c) => c.table === 'transactions' && c.method === 'update')).toBe(false)
  })
})
