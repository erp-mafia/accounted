/**
 * Pinning a document to a bank transaction, and taking it off, through the
 * v1 door of the operation registry (src/lib/operations/documents.ts):
 *   POST /api/v1/companies/:companyId/transactions/:id/attach-document
 *   POST /api/v1/companies/:companyId/transactions/:id/detach-document
 *
 * The rules are lib/transactions/document-attach.ts's, the same the dashboard
 * route and the MCP approval run: company ownership of both rows, never
 * replacing or detaching räkenskapsinformation (a further document on a
 * booked row joins its verifikat beside the pin), never another verifikat's
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
import { isIdempotencyClaim } from '@/tests/helpers'

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
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || (c.method === 'rpc' && !isIdempotencyClaim(c)))

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OLD_DOC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const OTHER_JE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
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

  it('409 DOC_ATTACH_REPLACES_POSTED when the pinned document is underlag of another verifikat than the row\'s booking', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: { id: TX_ID, document_id: OLD_DOC_ID, journal_entry_id: JE_ID }, error: null },
      document_attachments: { data: { journal_entry_id: OTHER_JE_ID }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ document_id: DOC_ID })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DOC_ATTACH_REPLACES_POSTED')
    expect(wrote(client)).toBe(false)
  })

  it('409 DOC_ATTACH_REPLACES_POSTED when the row is no longer booked but its pin is still a verifikat\'s underlag', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: { id: TX_ID, document_id: OLD_DOC_ID, journal_entry_id: null }, error: null },
      document_attachments: { data: { journal_entry_id: JE_ID }, error: null },
      transaction_voucher_links: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ document_id: DOC_ID })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DOC_ATTACH_REPLACES_POSTED')
    expect(wrote(client)).toBe(false)
  })

  // A row booked with one receipt took no second document: every attach was
  // refused as a replacement needing a storno, though nothing was replaced.
  // Staged attaches met it when the row was booked between staging and
  // approval; agents then linked the same document to the verifikat instead.
  it('adds the document to the row\'s verifikat beside a pin that is already its underlag, leaving the pin', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: [
        { data: { id: TX_ID, document_id: OLD_DOC_ID, journal_entry_id: JE_ID }, error: null },
        { data: { document_id: OLD_DOC_ID }, error: null },
      ],
      document_attachments: [
        { data: { journal_entry_id: JE_ID, file_name: 'kvitto.pdf' }, error: null }, // the pin
        { data: { id: DOC_ID, file_name: 'faktura.pdf', journal_entry_id: null }, error: null },
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
    const docUpdates = client.calls.filter((c) => c.table === 'document_attachments' && c.method === 'update')
    expect(docUpdates[0]?.args[0]).toEqual({
      journal_entry_id: JE_ID,
      link_basis: 'client_asserted',
      link_evidence: { rule_id: 'bank_row_extra_underlag' },
    })
    expect(client.calls).toContainEqual(
      expect.objectContaining({ table: 'document_attachments', method: 'eq', args: ['id', DOC_ID] }),
    )
    // The pin is räkenskapsinformation: it is never moved.
    expect(client.calls.some((c) => c.table === 'transactions' && c.method === 'update')).toBe(false)
    // The inbox item the document came from reads matched to the row.
    expect(client.calls).toContainEqual(
      expect.objectContaining({ table: 'invoice_inbox_items', method: 'update', args: [{ matched_transaction_id: TX_ID }] }),
    )
  })

  it('adds beside the pin on a samlingsverifikat the row is booked on through its voucher link', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: [
        { data: { id: TX_ID, document_id: OLD_DOC_ID, journal_entry_id: null }, error: null },
        { data: { document_id: OLD_DOC_ID }, error: null },
      ],
      transaction_voucher_links: { data: [{ transaction_id: TX_ID, journal_entry_id: JE_ID }], error: null },
      document_attachments: [
        { data: { journal_entry_id: JE_ID, file_name: 'kvitto.pdf' }, error: null },
        { data: { id: DOC_ID, file_name: 'faktura.pdf', journal_entry_id: null }, error: null },
        { data: null, error: null },
      ],
      invoice_inbox_items: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ document_id: DOC_ID })
    expect(res.status).toBe(200)
    expect((await res.json()).data.journal_entry_id).toBe(JE_ID)
    expect(client.calls.some((c) => c.table === 'transactions' && c.method === 'update')).toBe(false)
  })

  it('PERIOD_LOCKED when the verifikat\'s period is locked: nothing else is written', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: { data: { id: TX_ID, document_id: OLD_DOC_ID, journal_entry_id: JE_ID }, error: null },
      document_attachments: [
        { data: { journal_entry_id: JE_ID, file_name: 'kvitto.pdf' }, error: null },
        { data: { id: DOC_ID, file_name: 'faktura.pdf', journal_entry_id: null }, error: null },
        { data: null, error: { message: 'Cannot link documents to entries in a locked/closed fiscal period' } },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ document_id: DOC_ID })
    expect((await res.json()).error.code).toBe('PERIOD_LOCKED')
    const writes = client.calls.filter((c) => WRITES.has(c.method) && BOOKS.has(c.table)).map((c) => c.table)
    expect(writes).toEqual(['document_attachments'])
  })

  it('a dry run says the document is added beside the pin on the verifikat, and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      transactions: [
        { data: { id: TX_ID, document_id: OLD_DOC_ID, journal_entry_id: JE_ID, merchant_name: 'Clas Ohlson', amount: -499, currency: 'SEK', date: '2026-04-12' }, error: null },
        { data: [], error: null },
      ],
      document_attachments: [
        { data: { journal_entry_id: JE_ID, file_name: 'kvitto.pdf' }, error: null },
        { data: { id: DOC_ID, file_name: 'faktura.pdf', journal_entry_id: null }, error: null },
      ],
      pending_operations: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ document_id: DOC_ID }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({
      replaces_document: false,
      previous_document_stays: false,
      adds_to_verifikat: true,
      previous_document_id: OLD_DOC_ID,
      previous_document_file_name: 'kvitto.pdf',
    })
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
      transactions: [
        { data: { id: TX_ID, document_id: null, journal_entry_id: JE_ID, merchant_name: 'Clas Ohlson', amount: -499, currency: 'SEK', date: '2026-04-12' }, error: null },
        { data: [], error: null }, // no other transaction holds the document
      ],
      document_attachments: { data: { id: DOC_ID, file_name: 'k.pdf', journal_entry_id: null }, error: null },
      pending_operations: { data: [], error: null }, // no waiting link proposal
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
      // Both sides of the pairing, for whoever approves a staged attach.
      transaction_description: 'Clas Ohlson',
      transaction_amount: -499,
      transaction_date: '2026-04-12',
      document_file_name: 'k.pdf',
      shared_document_warning: null,
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
    expect(docUpdate?.args[0]).toEqual({
      journal_entry_id: JE_ID,
      // An API key pinned it: client_asserted, the pin as evidence.
      link_basis: 'client_asserted',
      link_evidence: { rule_id: 'bank_row_document_pin' },
    })
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
