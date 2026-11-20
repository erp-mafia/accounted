/**
 * Underlag behind an invoice through the v1 door of the operation registry
 * (src/lib/operations/invoice-underlag.ts via lib/operations/v1.ts):
 *   GET    /api/v1/companies/:companyId/invoices/:id/underlag
 *   POST   /api/v1/companies/:companyId/invoices/:id/underlag
 *   DELETE /api/v1/companies/:companyId/invoices/:id/underlag/:documentId
 *
 * The rules (lib/invoices/invoice-underlag.ts) are shared with the invoice
 * page and the MCP tools; here: auth and scope, validation, 404s, a dry run
 * writing nothing, and that a link never writes the document's own row.
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
import { createTableMockSupabase } from '@/tests/helpers'
import { GET, POST } from '../route'
import { DELETE } from '../[documentId]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type TableResp = { data?: unknown; error?: unknown }

/** Per-table queue mock (the last entry repeats) that records every (table, method, args). */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const mock = createTableMockSupabase()
  for (const [table, value] of Object.entries(byTable)) mock.setTable(table, value)
  return { calls: mock.calls, from: mock.supabase.from, rpc: mock.supabase.rpc }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DOC_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const INVOICE = { data: { id: INVOICE_ID, invoice_number: '1042' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/underlag`
const LINK = {
  document_id: DOC_A,
  created_at: '2026-11-06T10:00:00.000Z',
  document: {
    file_name: 'dahl-88412.pdf',
    mime_type: 'application/pdf',
    file_size_bytes: 61204,
    journal_entry_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    created_at: '2026-10-02T08:12:44.000Z',
    journal_entry: { voucher_series: 'B', voucher_number: 14 },
  },
}

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

const invoiceParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: INVOICE_ID }) }
const documentParams = (documentId: string) => ({
  params: Promise.resolve({ companyId: COMPANY_ID, id: INVOICE_ID, documentId }),
})

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const writesTo = (client: ReturnType<typeof makeClient>, table: string) =>
  client.calls.filter((c) => c.table === table && WRITES.has(c.method))

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Projektsystem',
    scopes: ['invoices:read', 'invoices:write'],
    mode: 'live',
  })
})

describe('GET /invoices/:id/underlag', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await GET(request(BASE), invoiceParams)
    expect(res.status).toBe(401)
  })

  it('403 without invoices:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await GET(request(BASE), invoiceParams)
    expect(res.status).toBe(403)
  })

  it('404 INVOICE_NOT_FOUND for an invoice outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, invoices: { data: null, error: null } }))
    const res = await GET(request(BASE), invoiceParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('200 with each document and its own verifikat', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, invoices: INVOICE, invoice_underlag: { data: [LINK], error: null } }),
    )
    const res = await GET(request(BASE), invoiceParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      invoice_id: INVOICE_ID,
      underlag: [
        {
          document_id: DOC_A,
          file_name: 'dahl-88412.pdf',
          mime_type: 'application/pdf',
          file_size_bytes: 61204,
          journal_entry_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          voucher: 'B14',
          document_created_at: '2026-10-02T08:12:44.000Z',
          attached_at: '2026-11-06T10:00:00.000Z',
        },
      ],
    })
  })
})

describe('POST /invoices/:id/underlag', () => {
  it('403 without invoices:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await POST(request(BASE, { method: 'POST', body: JSON.stringify({ document_ids: [DOC_A] }) }), invoiceParams)
    expect(res.status).toBe(403)
  })

  it('400 VALIDATION_ERROR for no documents and for a malformed id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    for (const body of ['{"document_ids":[]}', '{"document_ids":["nope"]}', '{}']) {
      const res = await POST(request(BASE, { method: 'POST', body }), invoiceParams)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('404 for a document the company does not have, writing nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: INVOICE,
      invoice_underlag: { data: [], error: null },
      document_attachments: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await POST(request(BASE, { method: 'POST', body: JSON.stringify({ document_ids: [DOC_A] }) }), invoiceParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND')
    expect(writesTo(client, 'invoice_underlag')).toEqual([])
  })

  it('a dry run previews the link and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: INVOICE,
      invoice_underlag: { data: [], error: null },
      document_attachments: { data: [{ id: DOC_A, file_name: 'dahl-88412.pdf', is_current_version: true }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await POST(
      request(`${BASE}?dry_run=true`, { method: 'POST', body: JSON.stringify({ document_ids: [DOC_A] }) }),
      invoiceParams,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      dry_run: true,
      preview: { attach: [{ document_id: DOC_A, file_name: 'dahl-88412.pdf' }], underlag_count_after: 1 },
    })
    expect(writesTo(client, 'invoice_underlag')).toEqual([])
  })

  it('links the document by reference: the document row is never written', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: INVOICE,
      invoice_underlag: [{ data: [], error: null }, { data: null, error: null }, { data: [LINK], error: null }],
      document_attachments: { data: [{ id: DOC_A, file_name: 'dahl-88412.pdf', is_current_version: true }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await POST(request(BASE, { method: 'POST', body: JSON.stringify({ document_ids: [DOC_A] }) }), invoiceParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ invoice_id: INVOICE_ID, attached_document_ids: [DOC_A] })
    expect(writesTo(client, 'invoice_underlag')).toEqual([
      { table: 'invoice_underlag', method: 'insert', args: [{ company_id: COMPANY_ID, invoice_id: INVOICE_ID, document_id: DOC_A }] },
    ])
    expect(writesTo(client, 'document_attachments')).toEqual([])
  })
})

describe('DELETE /invoices/:id/underlag/:documentId', () => {
  it('404 INVOICE_UNDERLAG_NOT_FOUND for a document the invoice does not rest on', async () => {
    const client = makeClient({ company_members: MEMBER, invoices: INVOICE, invoice_underlag: { data: [], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await DELETE(request(`${BASE}/${DOC_A}`, { method: 'DELETE' }), documentParams(DOC_A))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INVOICE_UNDERLAG_NOT_FOUND')
    expect(writesTo(client, 'invoice_underlag')).toEqual([])
  })

  it('removes only the link', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: INVOICE,
      invoice_underlag: [{ data: [LINK], error: null }, { data: [{ id: 'link-1' }], error: null }],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await DELETE(request(`${BASE}/${DOC_A}`, { method: 'DELETE' }), documentParams(DOC_A))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ invoice_id: INVOICE_ID, document_id: DOC_A, detached: true })
    expect(writesTo(client, 'invoice_underlag').map((c) => c.method)).toEqual(['delete'])
    expect(writesTo(client, 'document_attachments')).toEqual([])
  })
})
