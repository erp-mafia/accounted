import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  uploadDocument: vi.fn(),
  completePendingDocumentUpload: vi.fn(),
}))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(false) }
})
vi.mock('@/lib/documents/inbox-extraction/mirror-extraction', () => ({ mirrorExtractionToDocument: vi.fn() }))
vi.mock('@/lib/suppliers/match-supplier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suppliers/match-supplier')>()),
  matchSupplierId: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/documents/document-service')>()
  return { ...actual, uploadDocument: mocks.uploadDocument, completePendingDocumentUpload: mocks.completePendingDocumentUpload }
})

import { tools, type ActorContext } from '../server'

const companyId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const docId = '33333333-3333-4333-8333-333333333333'
const itemId = '44444444-4444-4444-8444-444444444444'
const STORAGE_PATH = `documents/${companyId}/${userId}/1_kvitto.pdf`

const tool = (name: string) => tools.find((t) => t.name === name)!

const arrivals: TableMockResolver = (calls) => {
  const upsert = calls.find((c) => c.method === 'upsert')
  if (upsert) return { data: [{ ...(upsert.args[0] as Record<string, unknown>), created_at: '2026-10-15T08:00:00Z' }] }
  return { data: null }
}

function db() {
  const mock = createTableMockSupabase({
    invoice_inbox_items: (calls) =>
      calls.some((c) => c.method === 'insert') ? { data: { id: itemId, status: 'received' } } : { data: null },
    document_attachments: {
      data: {
        id: docId,
        journal_entry_id: null,
        storage_path: STORAGE_PATH,
        sha256_hash: 'd'.repeat(64),
        mime_type: 'application/pdf',
        file_size_bytes: 9,
        file_name: 'kvitto.pdf',
      },
    },
    arrivals,
    arrival_outputs: { data: null },
  })
  return { ...mock, client: mock.supabase as unknown as SupabaseClient }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.uploadDocument.mockResolvedValue({ id: docId, mime_type: 'application/pdf' })
  mocks.completePendingDocumentUpload.mockResolvedValue({
    document: { id: docId, mime_type: 'application/pdf', deduplicated: false },
    buffer: new TextEncoder().encode('%PDF-1.4\n').buffer,
  })
})

describe('MCP uploads record an arrival', () => {
  it('gnubok_upload_document: source mcp, the key that fetched it, the document as its own original', async () => {
    const { client, payloads } = db()
    const actor: ActorContext = { type: 'mcp_oauth', id: 'key-1', label: 'Claude' }
    const result = await tool('gnubok_upload_document').execute(
      { file_name: 'kvitto.pdf', file_content_base64: Buffer.from('%PDF-1.4\n').toString('base64') },
      companyId,
      userId,
      client,
      actor,
    )
    expect(result).toMatchObject({ document_id: docId, inbox_item_id: itemId })

    const [arrival] = payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({
      company_id: companyId,
      source: 'mcp',
      source_ref: docId,
      original_path: STORAGE_PATH,
      fetched_by: { type: 'mcp_oauth', user_id: userId, api_key_id: 'key-1', label: 'Claude' },
    })
    const outputs = payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id])).toEqual([
      ['document', docId],
      ['inbox_item', itemId],
    ])
  })

  it('gnubok_complete_document_upload: records the arrival for the completed upload', async () => {
    const { client, payloads } = db()
    await tool('gnubok_complete_document_upload').execute(
      { upload_id: docId, file_name: 'kvitto.pdf' },
      companyId,
      userId,
      client,
      { type: 'api_key', id: 'key-2' },
    )
    const [arrival] = payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({ source: 'mcp', fetched_by: { type: 'api_key', api_key_id: 'key-2', user_id: userId } })
  })
})
