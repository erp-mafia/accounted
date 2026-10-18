/**
 * POST /api/v1/companies/{companyId}/inbox-items: the partner door into the
 * Inkorg.
 *
 * Runs the real withApiV1 wrapper (auth, scope, company gate, mandatory
 * Idempotency-Key and its replay) and the real arrivals layer against the
 * table mock. The invoice-inbox pipeline is the extension's registry
 * service, stubbed here (its own suite, invoice-inbox/__tests__/
 * inbox-delivery.test.ts, runs the real pipeline). The v1 surface is
 * API-key authenticated on createServiceClientNoCookies, so that is the
 * client mocked, as in the documents upload suite.
 */
import { createHash } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { createIdempotencyKeysFake } from '@/tests/idempotency-fake'

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

const { registryGetMock, fileInboxDeliveryMock, rateLimitMock } = vi.hoisted(() => ({
  registryGetMock: vi.fn(),
  fileInboxDeliveryMock: vi.fn(),
  rateLimitMock: vi.fn(),
}))
// Core cannot import the extension: the route resolves the pipeline through
// the registry's `services` channel, so that is what gets stubbed.
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: registryGetMock } }))
vi.mock('@/lib/rate-limits/inbox', () => ({ checkInboxUploadRateLimit: rateLimitMock }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DOC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ITEM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ARRIVAL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/inbox-items`
const PDF_BYTES = '%PDF-1.4\nfaktura 1001\n%%EOF\n'
const PDF_SHA = createHash('sha256').update(PDF_BYTES).digest('hex')
const STORAGE_PATH = `documents/${COMPANY_ID}/user-1/1_faktura.pdf`

const MEMBER = { company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null } }

function pdf(bytes = PDF_BYTES, name = 'faktura.pdf', type = 'application/pdf'): File {
  return new File([new TextEncoder().encode(bytes)], name, { type })
}

function deliver(
  fields: Record<string, string | File | Array<string | File>>,
  headers: Record<string, string> = { 'Idempotency-Key': 'billo-delivery-1' },
  url = URL,
): Request {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) form.append(key, v)
  }
  return new Request(url, {
    method: 'POST',
    body: form,
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key', ...headers },
  })
}

const params = () => ({ params: Promise.resolve({ companyId: COMPANY_ID }) })

/** arrivals: a lookup answers `existing`; an upsert echoes the row it wrote. */
function arrivalsTable(existing: Record<string, unknown> | null = null): TableMockResolver {
  return (calls) => {
    const upsert = calls.find((c) => c.method === 'upsert')
    if (upsert) return { data: [{ ...(upsert.args[0] as Record<string, unknown>), created_at: '2026-10-15T08:00:00Z' }] }
    return { data: existing }
  }
}

function db(overrides: Record<string, unknown> = {}) {
  return createTableMockSupabase({
    ...MEMBER,
    document_attachments: {
      data: { id: DOC_ID, storage_path: STORAGE_PATH, sha256_hash: PDF_SHA, mime_type: 'application/pdf', file_size_bytes: 30, file_name: 'faktura.pdf' },
    },
    arrivals: arrivalsTable(),
    arrival_outputs: { data: null },
    ...overrides,
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_billo',
    apiKeyName: 'Billo',
    scopes: ['documents:write'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(db().supabase)
  registryGetMock.mockResolvedValue({ id: 'invoice-inbox', services: { fileInboxDelivery: fileInboxDeliveryMock } })
  fileInboxDeliveryMock.mockResolvedValue({ document_id: DOC_ID, inbox_item_id: ITEM_ID, deduplicated: false })
  rateLimitMock.mockResolvedValue({ ok: true })
})

describe('POST /api/v1/companies/:companyId/inbox-items: auth and validation', () => {
  it('returns 401 when the API key is not valid', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key' })
    const res = await POST(deliver({ file: pdf() }), params())
    expect(res.status).toBe(401)
    expect(fileInboxDeliveryMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a key without documents:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', apiKeyId: 'ak_1', apiKeyName: 'Read key', scopes: ['documents:read'], mode: 'live' })
    const res = await POST(deliver({ file: pdf() }), params())
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('INSUFFICIENT_SCOPE')
    expect(fileInboxDeliveryMock).not.toHaveBeenCalled()
  })

  it('returns 404 for a company the key does not reach', async () => {
    mockServiceClient.mockReturnValue(db({ company_members: { data: null, error: null } }).supabase)
    const res = await POST(deliver({ file: pdf() }), params())
    expect(res.status).toBe(404)
    expect(fileInboxDeliveryMock).not.toHaveBeenCalled()
  })

  it('returns 400 without an Idempotency-Key header', async () => {
    const res = await POST(deliver({ file: pdf() }, {}), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(fileInboxDeliveryMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the body has no file part', async () => {
    const res = await POST(deliver({ external_ref: 'billo-1' }), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INBOX_UPLOAD_NO_FILE')
  })

  it('returns 400 for two files in one delivery', async () => {
    const res = await POST(deliver({ file: [pdf(), pdf('%PDF-1.4 other', 'b.pdf')] }), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error.details.field).toBe('file')
    expect(fileInboxDeliveryMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an office file the Inkorg does not take', async () => {
    const docx = pdf('PK', 'avtal.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const res = await POST(deliver({ file: docx }), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INBOX_UPLOAD_UNSUPPORTED_TYPE')
  })

  it('returns 400 for an empty file', async () => {
    const res = await POST(deliver({ file: pdf('') }), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('DOC_UPLOAD_EMPTY')
  })

  it.each([
    ['kind_hint', 'credit_note'],
    ['external_ref', 'x'.repeat(201)],
    ['external_ref', '   '],
    ['received_at', '15 oktober'],
  ])('returns 400 for %s=%j', async (field, value) => {
    const res = await POST(deliver({ file: pdf(), [field]: value }), params())
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues[0].field).toBe(field)
    expect(fileInboxDeliveryMock).not.toHaveBeenCalled()
  })

  it('refuses ?dry_run=true from a live key instead of filing for real', async () => {
    const res = await POST(deliver({ file: pdf() }, { 'Idempotency-Key': 'k-dry' }, `${URL}?dry_run=true`), params())
    expect(res.status).toBe(400)
    expect(fileInboxDeliveryMock).not.toHaveBeenCalled()
  })

  it('answers 503 EXTENSION_DISABLED on a deployment without the Inkorg', async () => {
    registryGetMock.mockResolvedValue(undefined)
    const res = await POST(deliver({ file: pdf() }), params())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('EXTENSION_DISABLED')
    expect(body.error.message).toBe('Funktionen är inte aktiverad i den här installationen.')
    expect(body.error.details).toMatchObject({ extension: 'invoice-inbox' })
  })
})

describe('POST /api/v1/companies/:companyId/inbox-items: delivery', () => {
  it('files through the pipeline, records a partner_api arrival and answers 201', async () => {
    const mock = db()
    mockServiceClient.mockReturnValue(mock.supabase)

    const res = await POST(
      deliver({
        file: pdf(),
        kind_hint: 'supplier_invoice',
        external_ref: 'billo-8f2c1a',
        sender_name: 'Leverantören AB',
        sender_org_number: '556677-8899',
        subject: 'Faktura 1001',
        message: 'Förfaller 2026-11-14',
        received_at: '2026-10-15T10:00:00+02:00',
      }),
      params(),
    )
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.data).toEqual({ inbox_item_id: ITEM_ID, document_id: DOC_ID, deduplicated: false, arrival_id: expect.any(String) })

    expect(fileInboxDeliveryMock).toHaveBeenCalledOnce()
    const [, input] = fileInboxDeliveryMock.mock.calls[0]
    expect(input).toMatchObject({
      userId: 'user-1',
      companyId: COMPANY_ID,
      file: { name: 'faktura.pdf', type: 'application/pdf' },
      kindHint: 'supplier_invoice',
      senderName: 'Leverantören AB',
      subject: 'Faktura 1001',
      receivedAt: '2026-10-15T08:00:00.000Z',
      channelContext: { channel: 'partner_api', intake_source: 'partner_api', partner_key_label: 'Billo', external_ref: 'billo-8f2c1a' },
    })
    expect(new TextDecoder().decode(input.file.buffer)).toBe(PDF_BYTES)

    const [arrival] = mock.payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({
      company_id: COMPANY_ID,
      source: 'partner_api',
      source_ref: 'billo-8f2c1a',
      received_at: '2026-10-15T08:00:00.000Z',
      sender: { name: 'Leverantören AB', org_number: '556677-8899' },
      subject: 'Faktura 1001',
      message_text: 'Förfaller 2026-11-14',
      original_path: STORAGE_PATH,
      original_sha256: PDF_SHA,
      fetched_by: { type: 'api_key', user_id: 'user-1', api_key_id: 'ak_billo', label: 'Billo' },
      source_meta: {
        document_id: DOC_ID,
        operation: 'inbox-items.deliver',
        external_ref: 'billo-8f2c1a',
        kind_hint: 'supplier_invoice',
        idempotency_key: 'billo-delivery-1',
      },
    })
    expect(body.data.arrival_id).toBe(arrival.id)
    const outputs = mock.payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id])).toEqual([
      ['document', DOC_ID],
      ['inbox_item', ITEM_ID],
    ])
  })

  it('books nothing: no supplier invoice, no verifikat, no commit', async () => {
    const mock = db()
    mockServiceClient.mockReturnValue(mock.supabase)

    const res = await POST(deliver({ file: pdf(), kind_hint: 'supplier_invoice', external_ref: 'billo-1' }), params())

    expect(res.status).toBe(201)
    const touched = mock.tables()
    for (const table of ['supplier_invoices', 'supplier_invoice_items', 'journal_entries', 'journal_entry_lines']) {
      expect(touched).not.toContain(table)
    }
    expect(mock.supabase.rpc).not.toHaveBeenCalledWith('commit_journal_entry', expect.anything())
  })

  it('without external_ref the arrival is keyed by the document id', async () => {
    const mock = db()
    mockServiceClient.mockReturnValue(mock.supabase)

    const res = await POST(deliver({ file: pdf() }), params())

    expect(res.status).toBe(201)
    const [arrival] = mock.payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival.source_ref).toBe(DOC_ID)
    expect(fileInboxDeliveryMock.mock.calls[0][1].channelContext.external_ref).toBeNull()
  })

  it("names a service account's delivery as the account, with its sponsor as the person", async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_billo',
      apiKeyName: 'Billo key',
      scopes: ['documents:write'],
      mode: 'live',
      serviceAccount: { id: 'sa-billo', name: 'Billo' },
      allowedCompanyIds: [COMPANY_ID],
    })
    const mock = db()
    mockServiceClient.mockReturnValue(mock.supabase)

    const res = await POST(deliver({ file: pdf() }), params())

    expect(res.status).toBe(201)
    const [arrival] = mock.payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival.fetched_by).toEqual({
      type: 'service_account', user_id: 'user-1', api_key_id: 'ak_billo', service_account_id: 'sa-billo', label: 'Billo',
    })
  })

  it('answers 200 deduplicated when the same file is already in the Inkorg', async () => {
    fileInboxDeliveryMock.mockResolvedValue({ document_id: DOC_ID, inbox_item_id: ITEM_ID, deduplicated: true })
    const res = await POST(deliver({ file: pdf(), external_ref: 'billo-2' }), params())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ inbox_item_id: ITEM_ID, deduplicated: true })
  })

  it('still answers 201 when the arrival cannot be recorded', async () => {
    mockServiceClient.mockReturnValue(db({ document_attachments: { data: null, error: { message: 'boom' } } }).supabase)
    const res = await POST(deliver({ file: pdf() }), params())
    expect(res.status).toBe(201)
    expect((await res.json()).data.arrival_id).toBeNull()
  })

  it('answers 429 with Retry-After when the Inkorg quota is spent, and files nothing', async () => {
    rateLimitMock.mockResolvedValue({ ok: false, scope: 'minute', retryAfterSec: 42 })
    const res = await POST(deliver({ file: pdf() }), params())
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('42')
    expect(fileInboxDeliveryMock).not.toHaveBeenCalled()
  })

  it('maps a content refusal to 400 and any other pipeline failure to 500', async () => {
    fileInboxDeliveryMock.mockRejectedValueOnce(new Error('Filens innehåll matchar inte den angivna filtypen.'))
    const refused = await POST(deliver({ file: pdf() }, { 'Idempotency-Key': 'k-a' }), params())
    expect(refused.status).toBe(400)
    expect((await refused.json()).error.code).toBe('DOC_UPLOAD_INVALID_CONTENT')

    fileInboxDeliveryMock.mockRejectedValueOnce(new Error('Failed to create inbox item: connection reset'))
    const failed = await POST(deliver({ file: pdf() }, { 'Idempotency-Key': 'k-b' }), params())
    const body = await failed.json()
    expect(failed.status).toBe(500)
    expect(body.error.code).toBe('INBOX_UPLOAD_FAILED')
    expect(JSON.stringify(body)).not.toContain('connection reset')
  })
})

describe('POST /api/v1/companies/:companyId/inbox-items: retries', () => {
  it('a repeated external_ref returns the first delivery (200) without filing or spending quota', async () => {
    const mock = db({
      arrivals: arrivalsTable({ id: ARRIVAL_ID, original_sha256: PDF_SHA }),
      arrival_outputs: {
        data: [
          { output_kind: 'document', output_id: DOC_ID, position: 0 },
          { output_kind: 'inbox_item', output_id: ITEM_ID, position: 1 },
        ],
      },
    })
    mockServiceClient.mockReturnValue(mock.supabase)

    const res = await POST(deliver({ file: pdf(), external_ref: 'billo-8f2c1a' }, { 'Idempotency-Key': 'a-new-key' }), params())

    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ inbox_item_id: ITEM_ID, document_id: DOC_ID, deduplicated: true, arrival_id: ARRIVAL_ID })
    expect(fileInboxDeliveryMock).not.toHaveBeenCalled()
    expect(rateLimitMock).not.toHaveBeenCalled()
    expect(mock.payloads('arrivals', 'upsert')).toEqual([])
  })

  it('the same external_ref with a different file answers 409 and files nothing', async () => {
    mockServiceClient.mockReturnValue(
      db({
        arrivals: arrivalsTable({ id: ARRIVAL_ID, original_sha256: 'f'.repeat(64) }),
        arrival_outputs: { data: [{ output_kind: 'inbox_item', output_id: ITEM_ID, position: 1 }] },
      }).supabase,
    )

    const res = await POST(deliver({ file: pdf(), external_ref: 'billo-8f2c1a' }), params())
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error.code).toBe('INBOX_DELIVERY_REF_CONFLICT')
    expect(body.error.details).toMatchObject({ external_ref: 'billo-8f2c1a', inbox_item_id: ITEM_ID })
    expect(fileInboxDeliveryMock).not.toHaveBeenCalled()
  })

  it('a known external_ref whose item link is missing files again (content dedupe converges)', async () => {
    mockServiceClient.mockReturnValue(
      db({ arrivals: arrivalsTable({ id: ARRIVAL_ID, original_sha256: PDF_SHA }), arrival_outputs: { data: [] } }).supabase,
    )
    fileInboxDeliveryMock.mockResolvedValue({ document_id: DOC_ID, inbox_item_id: ITEM_ID, deduplicated: true })

    const res = await POST(deliver({ file: pdf(), external_ref: 'billo-8f2c1a' }), params())

    expect(res.status).toBe(200)
    expect(fileInboxDeliveryMock).toHaveBeenCalledOnce()
  })

  it('a resend under the same Idempotency-Key replays the first answer, even re-encoded', async () => {
    const keys = createIdempotencyKeysFake()
    const mock = db()
    const original = mock.supabase.from.getMockImplementation()!
    mock.supabase.from.mockImplementation(((table: string) =>
      table === 'idempotency_keys' ? keys.table() : original(table)) as never)
    mockServiceClient.mockReturnValue(mock.supabase)

    const fields = { file: pdf(), external_ref: 'billo-77', sender_name: 'Leverantören AB' }
    const first = await POST(deliver(fields, { 'Idempotency-Key': 'billo-77-try' }), params())
    // A fresh FormData: the client encodes a new boundary for the resend.
    const second = await POST(deliver({ ...fields, file: pdf() }, { 'Idempotency-Key': 'billo-77-try' }), params())

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.headers.get('Idempotent-Replayed')).toBe('true')
    expect((await second.json()).data).toEqual((await first.json()).data)
    expect(fileInboxDeliveryMock).toHaveBeenCalledOnce()
    expect(keys.rows).toHaveLength(1)
  })
})
