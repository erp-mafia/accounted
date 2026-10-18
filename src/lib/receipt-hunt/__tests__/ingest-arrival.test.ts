import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import type { MailCandidate } from '@/lib/mail-search/service'

const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn().mockResolvedValue('event-1') }))
vi.mock('@/lib/suppliers/match-supplier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suppliers/match-supplier')>()),
  matchSupplierId: vi.fn().mockResolvedValue(null),
}))
const mockFetchAttachment = vi.fn()
vi.mock('@/lib/mail-search/service', () => ({
  getMailSearchService: () => ({ fetchAttachment: (...args: unknown[]) => mockFetchAttachment(...args), search: vi.fn(), isConfigured: () => true }),
}))

import { ingestMailCandidate } from '../ingest'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const DOC = '33333333-3333-4333-8333-333333333333'
const ITEM = '44444444-4444-4444-8444-444444444444'
const OLD_ITEM = '55555555-5555-4555-8555-555555555555'

function candidate(overrides: Partial<MailCandidate> = {}): MailCandidate {
  return {
    connectionId: 'conn-1',
    mailbox: 'ekonomi@nordvik.example',
    provider: 'gmail',
    messageId: 'gmail-msg-1',
    subject: 'Ditt kvitto',
    from: 'no-reply@circlek.example',
    receivedAt: '2026-05-02T10:00:00Z',
    attachmentIds: ['att-1'],
    bodyIsReceipt: false,
    ...overrides,
  }
}

const arrivals: TableMockResolver = (calls) => {
  const upsert = calls.find((c) => c.method === 'upsert')
  if (upsert) return { data: [{ ...(upsert.args[0] as Record<string, unknown>), created_at: '2026-05-02T10:05:00Z' }] }
  return { data: null }
}

function db(inboxItems: Array<{ data?: unknown; error?: unknown }>) {
  const mock = createTableMockSupabase({
    invoice_inbox_items: inboxItems,
    document_attachments: { data: { extracted_data: null } },
    arrivals,
    arrival_outputs: { data: null },
  } as never)
  return { ...mock, client: mock.supabase as unknown as SupabaseClient }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchAttachment.mockResolvedValue({ filename: 'kvitto.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4') })
  mockUploadDocument.mockResolvedValue({ id: DOC, mime_type: 'application/pdf', deduplicated: false })
})

describe('hunted mail arrivals', () => {
  it('records the hunted message envelope as a mailbox arrival and links the filed attachment', async () => {
    // No provenance row yet, then the insert answers with the new item.
    const { client, payloads } = db([{ data: null }, { data: { id: ITEM } }])
    const filed = await ingestMailCandidate(client, COMPANY, 'user-1', candidate())
    expect(filed).toMatchObject({ documentId: DOC, inboxItemId: ITEM })

    const [arrival] = payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({
      company_id: COMPANY,
      source: 'mailbox',
      source_ref: 'gmail-msg-1',
      received_at: '2026-05-02T10:00:00.000Z',
      sender: { from: 'no-reply@circlek.example' },
      subject: 'Ditt kvitto',
      // The hunt never keeps the body.
      message_text: null,
      original_path: null,
      fetched_by: { type: 'system', label: 'receipt-hunt' },
    })
    expect(arrival!.source_meta).toMatchObject({ provider: 'gmail', mailbox: 'ekonomi@nordvik.example', connection_id: 'conn-1' })
    const outputs = payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id, o.position])).toEqual([
      ['document', DOC, 0],
      ['inbox_item', ITEM, 0],
    ])
  })

  it('links a deduplicated receipt to the item that already holds it', async () => {
    mockUploadDocument.mockResolvedValue({ id: DOC, mime_type: 'application/pdf', deduplicated: true })
    const { client, payloads } = db([{ data: null }, { data: { id: OLD_ITEM } }])
    expect(await ingestMailCandidate(client, COMPANY, 'user-1', candidate())).toBeNull()
    const outputs = payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id])).toEqual([
      ['document', DOC],
      ['inbox_item', OLD_ITEM],
    ])
  })

  it('records a Microsoft mailbox through the same door, with the provider in source_meta', async () => {
    const { client, payloads } = db([{ data: null }, { data: { id: ITEM } }])
    await ingestMailCandidate(client, COMPANY, 'user-1', candidate({ provider: 'microsoft', messageId: 'AAMkAD-1' }))
    const [arrival] = payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({ source: 'mailbox', source_ref: 'AAMkAD-1', source_meta: { provider: 'microsoft' } })
  })
})
