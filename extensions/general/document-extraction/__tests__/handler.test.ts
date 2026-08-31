import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => supabase,
}))

const extractMock = vi.fn()
vi.mock('@/extensions/general/invoice-inbox/lib/extract-invoice-fields', () => ({
  extractInvoiceFields: (...args: unknown[]) => extractMock(...args),
  fetchOwnCompanyIdentity: vi.fn().mockResolvedValue({ orgNumber: null, name: null }),
}))

const hasCapabilityMock = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: (...args: unknown[]) => hasCapabilityMock(...args),
}))

const aiStatusMock = vi.fn()
vi.mock('@/lib/ai', () => ({
  getAiStatus: () => aiStatusMock(),
}))

import { documentExtractionExtension } from '../index'

const handler = documentExtractionExtension.eventHandlers![0].handler

function doc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    company_id: 'company-1',
    file_name: 'kvitto.pdf',
    mime_type: 'application/pdf',
    storage_path: 'company-1/user-1/kvitto.pdf',
    upload_source: 'file_upload',
    ...overrides,
  }
}

function payload(overrides: Record<string, unknown> = {}, document = doc()) {
  return { document, userId: 'user-1', companyId: 'company-1', ...overrides }
}

/** extraction_model of the LAST document_attachments update, or undefined. */
function lastStamp(): string | undefined {
  const updates = findCalls('document_attachments', 'update')
  const last = updates[updates.length - 1]?.[0] as { extraction_model?: string } | undefined
  return last?.extraction_model
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  aiStatusMock.mockReturnValue({ configured: true, assistantAvailable: true })
  hasCapabilityMock.mockResolvedValue(true)
  extractMock.mockResolvedValue({
    data: { supplier: { name: 'Elgiganten' } },
    rawText: '{"supplier":{"name":"Elgiganten"}}',
    model: 'eu.anthropic.claude-sonnet-5',
  })
})

describe('document-extraction handler', () => {
  // THE dedupe: inbox-owned documents are extracted (and mirrored) by the
  // inbox itself. The handler used to race it and pay a second model call.
  it('stamps and skips when the uploader opted out (already-booked provider underlag)', async () => {
    await handler(payload({ extractionOwner: 'none' }))

    expect(extractMock).not.toHaveBeenCalled()
    expect(lastStamp()).toBe('skipped:opted_out')
  })

  it('yields entirely when the inbox owns extraction', async () => {
    await handler(payload({ extractionOwner: 'invoice-inbox' }))
    expect(supabase.from).not.toHaveBeenCalled()
    expect(extractMock).not.toHaveBeenCalled()
  })

  it('stamps unsupported types from the payload without reading the row', async () => {
    enqueue({ data: null }) // the stamp update
    await handler(payload({}, doc({ mime_type: 'application/json' })))
    expect(findCalls('document_attachments', 'select')).toHaveLength(0)
    expect(lastStamp()).toBe('skipped:unsupported_mime')
    expect(extractMock).not.toHaveBeenCalled()
  })

  // Our own invoice PDFs, payout files, filings: nothing to read, paid calls
  // to waste (on hosted and on a BYO-key self-host).
  it('stamps system-generated documents instead of extracting them', async () => {
    enqueue({ data: null })
    await handler(payload({}, doc({ upload_source: 'system' })))
    expect(lastStamp()).toBe('skipped:system_generated')
    expect(extractMock).not.toHaveBeenCalled()
  })

  it('does nothing for a row that was already attempted', async () => {
    enqueue({ data: { id: 'doc-1', mime_type: 'application/pdf', storage_path: 'p', extracted_at: '2026-08-20T00:00:00Z' } })
    await handler(payload())
    expect(findCalls('document_attachments', 'update')).toHaveLength(0)
    expect(extractMock).not.toHaveBeenCalled()
  })

  // Self-host without an AI key: stamp so the status route answers
  // 'disabled' on the first poll instead of after a 30 s timeout.
  it('stamps ai_unconfigured when the deployment has no AI', async () => {
    aiStatusMock.mockReturnValue({ configured: false, assistantAvailable: false })
    enqueue({ data: { id: 'doc-1', mime_type: 'application/pdf', storage_path: 'p', extracted_at: null } })
    enqueue({ data: null })
    await handler(payload())
    expect(lastStamp()).toBe('skipped:ai_unconfigured')
    expect(hasCapabilityMock).not.toHaveBeenCalled()
    expect(extractMock).not.toHaveBeenCalled()
  })

  // The paywall, made visible: 309 of the 327 never-extracted uploads in a
  // 30-day prod window belonged to companies without the ai capability.
  it('stamps no_ai_entitlement for companies without the ai capability', async () => {
    hasCapabilityMock.mockResolvedValue(false)
    enqueue({ data: { id: 'doc-1', mime_type: 'application/pdf', storage_path: 'p', extracted_at: null } })
    enqueue({ data: null })
    await handler(payload())
    expect(lastStamp()).toBe('skipped:no_ai_entitlement')
    expect(extractMock).not.toHaveBeenCalled()
  })

  it('stamps a storage download failure', async () => {
    enqueue({ data: { id: 'doc-1', mime_type: 'application/pdf', storage_path: 'p', extracted_at: null } })
    enqueue({ data: null })
    supabase.storage.from.mockReturnValueOnce({
      download: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
    })
    await handler(payload())
    expect(lastStamp()).toBe('failed:storage_download')
    expect(extractMock).not.toHaveBeenCalled()
  })

  it('persists the result with the model that answered', async () => {
    enqueue({ data: { id: 'doc-1', mime_type: 'application/pdf', storage_path: 'p', extracted_at: null } })
    enqueue({ data: null })
    await handler(payload())
    expect(extractMock).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'application/pdf', fileName: 'kvitto.pdf' }))
    const updates = findCalls('document_attachments', 'update')
    expect(updates[updates.length - 1][0]).toMatchObject({
      extracted_data: { supplier: { name: 'Elgiganten' } },
      extraction_model: 'eu.anthropic.claude-sonnet-5',
    })
  })

  it('stamps the skip reason the extractor reports (no vision, rasterizer missing, ...)', async () => {
    extractMock.mockResolvedValue({ data: {}, rawText: null, skipped: 'pdf_rasterizer_missing' })
    enqueue({ data: { id: 'doc-1', mime_type: 'application/pdf', storage_path: 'p', extracted_at: null } })
    enqueue({ data: null })
    await handler(payload())
    expect(lastStamp()).toBe('skipped:pdf_rasterizer_missing')
  })

  it('stamps failed:no_raw_text when the model call produced nothing parseable', async () => {
    extractMock.mockResolvedValue({ data: {}, rawText: null })
    enqueue({ data: { id: 'doc-1', mime_type: 'application/pdf', storage_path: 'p', extracted_at: null } })
    enqueue({ data: null })
    await handler(payload())
    expect(lastStamp()).toBe('failed:no_raw_text')
  })
})
