/**
 * GET /api/v1/companies/:companyId/documents/search through the v1 door of
 * documents.search (src/lib/operations/document-search.ts via lib/operations/v1.ts).
 *
 * The answer is gnubok_search_records' (lib/arkiv/search.ts searchArchive):
 * page hits first with the passage, then file-name matches, agreements and
 * facts where the company brain runs, a later copy marked duplicate_of the
 * first, and the unread count with a hint in the v1 door's own terms. The
 * search itself is tested in lib/arkiv/__tests__/search.test.ts.
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
const brain = vi.hoisted(() => ({ on: false }))
vi.mock('@/lib/arkiv/flag', async () => {
  const actual = await vi.importActual<typeof import('@/lib/arkiv/flag')>('@/lib/arkiv/flag')
  return { ...actual, isArkivBrainEnabled: () => brain.on }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET as searchDocuments } from '../search/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const COPY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NAMED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/documents/search`

interface Archive {
  pages?: unknown[]
  /** The file-name matches. */
  named?: unknown[]
  /** Every document of the company, as the hit rows and the byte-hash twins read them. */
  documents?: Array<{ id: string; created_at: string; sha256_hash: string }>
  unread?: number
  agreements?: unknown[]
  facts?: unknown[]
}

type Calls = Array<{ method: string; args: unknown[] }>
const arg = (calls: Calls, method: string, column: string) => calls.find((c) => c.method === method && c.args[0] === column)?.args[1]

/** One request's database: document_attachments answers each read by its shape. */
function db(archive: Archive = {}) {
  const documents = archive.documents ?? []
  const mock = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'member' } },
    'rpc:search_document_pages': { data: archive.pages ?? [] },
    document_attachments: (calls: Calls) => {
      if (calls.some((c) => c.method === 'ilike')) return { data: archive.named ?? [] }
      const ids = arg(calls, 'in', 'id') as string[] | undefined
      if (ids) return { data: documents.filter((d) => ids.includes(d.id)) }
      const hashes = arg(calls, 'in', 'sha256_hash') as string[] | undefined
      if (hashes) return { data: documents.filter((d) => hashes.includes(d.sha256_hash)) }
      return { count: archive.unread ?? 0 }
    },
    document_classifications: { data: [] },
    agreements: { data: archive.agreements ?? [] },
    company_facts: { data: archive.facts ?? [] },
  })
  mockServiceClient.mockReturnValue(mock.supabase)
  return mock
}

const get = (query: string) =>
  searchDocuments(
    new Request(`${BASE}${query}`, { method: 'GET', headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } }),
    { params: Promise.resolve({ companyId: COMPANY_ID }) },
  )

beforeEach(() => {
  vi.clearAllMocks()
  brain.on = false
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Portal',
    scopes: ['documents:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/documents/search', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    db()
    expect((await get('?query=hyra')).status).toBe(401)
  })

  it('403 without documents:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    const mock = db()
    expect((await get('?query=hyra')).status).toBe(403)
    expect(mock.calls.filter((c) => c.table === 'rpc:search_document_pages')).toEqual([])
  })

  it.each(['', '?query=h', '?query=hyra&kinds=invoice', '?query=hyra&limit=51'])('400 on %s', async (query) => {
    const mock = db()
    const res = await get(query)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(mock.calls.filter((c) => c.table === 'rpc:search_document_pages')).toEqual([])
  })

  it('answers page hits with the passage, then file-name matches, a later copy marked, in the company only', async () => {
    const mock = db({
      pages: [
        { document_id: DOC, page_no: 2, file_name: 'hyresavtal.pdf', headline: 'Hyran uppgår till <b>12 500</b>' },
        { document_id: COPY, page_no: 1, file_name: 'hyresavtal (1).pdf', headline: 'Hyran uppgår till <b>12 500</b>' },
      ],
      named: [{ id: NAMED, file_name: 'hyra-mars.pdf' }],
      documents: [
        { id: DOC, created_at: '2026-01-01T00:00:00Z', sha256_hash: 'same' },
        { id: COPY, created_at: '2026-02-01T00:00:00Z', sha256_hash: 'same' },
        { id: NAMED, created_at: '2026-03-01T00:00:00Z', sha256_hash: 'other' },
      ],
      unread: 3,
    })
    const res = await get('?query=%20hyra%20&limit=5')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.items).toEqual([
      { record_ref: `document:${DOC}`, kind: 'document', title: 'hyresavtal.pdf', snippet: 'Hyran uppgår till <b>12 500</b>', document_id: DOC, page: 2, duplicate_of: null },
      { record_ref: `document:${COPY}`, kind: 'document', title: 'hyresavtal (1).pdf', snippet: 'Hyran uppgår till <b>12 500</b>', document_id: COPY, page: 1, duplicate_of: `document:${DOC}` },
      { record_ref: `document:${NAMED}`, kind: 'document', title: 'hyra-mars.pdf', snippet: null, document_id: NAMED, page: null, duplicate_of: null },
    ])
    expect(data).toMatchObject({ count: 3, unread: 3 })
    expect(data.hint).toMatch(/^3 documents are not read yet: their file names are searched/)
    // The words trimmed, the company's own archive.
    expect(mock.findCall('rpc:search_document_pages', 'rpc')).toEqual([{ p_company_id: COMPANY_ID, p_query: 'hyra', p_limit: 5 }])
    expect(mock.calls).toContainEqual({ table: 'document_attachments', method: 'eq', args: ['company_id', COMPANY_ID] })
  })

  it('searches only the documents outside the company brain, whatever kinds asks for', async () => {
    const mock = db()
    const res = await get('?query=l%C3%A5n&kinds=agreement,fact,document')
    expect(res.status).toBe(200)
    expect(mock.findCalls('agreements', 'select')).toEqual([])
    expect(mock.findCalls('company_facts', 'select')).toEqual([])
  })

  it('adds agreements and facts where the brain runs, and only the kinds asked for', async () => {
    brain.on = true
    const mock = db({
      agreements: [{ id: AGR, title: 'Hyresavtal Vasagatan 12', counterparty_name: 'Fastighets AB', kind: 'rental', ends_on: '2028-12-31' }],
    })
    const res = await get('?query=hyresavtal&kinds=agreement')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.items).toEqual([
      { record_ref: `agreement:${AGR}`, kind: 'agreement', title: 'Hyresavtal Vasagatan 12', snippet: 'rental · Fastighets AB · till 2028-12-31', document_id: null, page: null, duplicate_of: null },
    ])
    expect(mock.calls.filter((c) => c.table === 'rpc:search_document_pages')).toEqual([])
    expect(mock.findCalls('company_facts', 'select')).toEqual([])
  })

  it('words one unread document in the singular', async () => {
    db({ unread: 1 })
    const { data } = await (await get('?query=hyra')).json()
    expect(data.hint).toMatch(/^1 document is not read yet: its file name is searched, its text only once it has been read\./)
  })

  it('an empty answer says the archive is not a search of the books', async () => {
    db()
    const res = await get('?query=20769')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({ items: [], count: 0, unread: 0 })
    expect(data.hint).toMatch(/^Nothing in the archive matched\..*invoices, orders and bank rows are not in it/)
  })
})
