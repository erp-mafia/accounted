import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createMockRequest, createTableMockSupabase, parseJsonResponse, testRoutes, type TableMockResolver } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn(),
  createPendingDocumentUpload: vi.fn(),
  completePendingDocumentUpload: vi.fn(),
  linkToJournalEntry: vi.fn(),
}))
vi.mock('@/extensions/general/invoice-inbox/lib/upload-and-extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/extensions/general/invoice-inbox/lib/upload-and-extract')>()
  return { ...actual, processArchivedDocument: vi.fn(), uploadAndExtract: vi.fn() }
})
vi.mock('@/lib/rate-limits/inbox', () => ({ checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }) }))

import { completePendingDocumentUpload } from '@/lib/core/documents/document-service'
import { processArchivedDocument, uploadAndExtract } from '@/extensions/general/invoice-inbox/lib/upload-and-extract'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const DOC = '33333333-3333-4333-8333-333333333333'
const ITEM = '44444444-4444-4444-8444-444444444444'
const STORAGE_PATH = `documents/${COMPANY}/${USER}/1_kvitto.pdf`

const route = (path: string) => testRoutes(invoiceInboxExtension).find((r) => r.method === 'POST' && r.path === path)!

function ctx(supabase: unknown): ExtensionContext {
  return {
    userId: USER,
    companyId: COMPANY,
    extensionId: 'invoice-inbox',
    requestId: 'req_test',
    supabase,
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    services: {},
  } as unknown as ExtensionContext
}

const arrivals: TableMockResolver = (calls) => {
  const upsert = calls.find((c) => c.method === 'upsert')
  if (upsert) return { data: [{ ...(upsert.args[0] as Record<string, unknown>), created_at: '2026-10-15T08:00:00Z' }] }
  return { data: null }
}

function db(overrides: Record<string, unknown> = {}) {
  return createTableMockSupabase({
    invoice_inbox_items: { data: null },
    document_attachments: {
      data: { id: DOC, storage_path: STORAGE_PATH, sha256_hash: 'c'.repeat(64), mime_type: 'application/pdf', file_size_bytes: 2048, file_name: 'kvitto.pdf' },
    },
    arrivals,
    arrival_outputs: { data: null },
    ...overrides,
  } as never)
}

const RESULT = { document_id: DOC, inbox_item_id: ITEM, status: 'processing', extracted_data: null }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uploadAndExtract).mockResolvedValue(RESULT as never)
  vi.mocked(processArchivedDocument).mockResolvedValue(RESULT as never)
  vi.mocked(completePendingDocumentUpload).mockResolvedValue({
    document: { id: DOC, mime_type: 'application/pdf' },
    buffer: new TextEncoder().encode('%PDF-1.4').buffer,
  } as never)
})

function multipart() {
  const form = new FormData()
  form.append('file', new File([new TextEncoder().encode('%PDF-1.4')], 'kvitto.pdf', { type: 'application/pdf' }))
  return new Request('http://localhost/upload', { method: 'POST', body: form })
}

describe('upload doors record an arrival', () => {
  it('POST /upload: the uploaded document is its own original, linked with its inbox item', async () => {
    const mock = db()
    const res = await route('/upload').handler(multipart(), ctx(mock.supabase))
    const { status, body } = await parseJsonResponse<{ data: typeof RESULT }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(RESULT)

    const [arrival] = mock.payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({
      company_id: COMPANY,
      source: 'upload',
      source_ref: DOC,
      original_path: STORAGE_PATH,
      original_sha256: 'c'.repeat(64),
      fetched_by: { type: 'user', user_id: USER },
    })
    const outputs = mock.payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id])).toEqual([
      ['document', DOC],
      ['inbox_item', ITEM],
    ])
  })

  it('POST /upload/complete: the direct upload records the same arrival', async () => {
    const mock = db()
    const res = await route('/upload/complete').handler(
      createMockRequest('/upload/complete', { method: 'POST', body: { upload_id: DOC, file_name: 'kvitto.pdf', mime_type: 'application/pdf' } }),
      ctx(mock.supabase),
    )
    expect(res.status).toBe(200)
    const [arrival] = mock.payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({ source: 'upload', source_ref: DOC, original_path: STORAGE_PATH })
  })

  it('answers the upload as before when the arrival cannot be recorded', async () => {
    const mock = db({ arrivals: { data: null, error: { message: 'permission denied for table arrivals' } } })
    const res = await route('/upload').handler(multipart(), ctx(mock.supabase))
    const { status, body } = await parseJsonResponse<{ data: typeof RESULT }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(RESULT)
  })
})
