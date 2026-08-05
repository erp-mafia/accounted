import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT' }),
    markReadWithTyping: vi.fn().mockResolvedValue(undefined),
    downloadMedia: vi.fn(),
  }
})

vi.mock('@/extensions/general/invoice-inbox/lib/upload-and-extract', () => ({
  uploadAndExtract: vi.fn(),
}))

vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-1'),
}))

vi.mock('@/lib/core/documents/document-service', () => ({
  computeSHA256: vi.fn().mockResolvedValue('sha-abc'),
}))

import {
  sendText,
  markReadWithTyping,
  downloadMedia,
  GraphApiError,
} from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { uploadAndExtract } from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { processInboundMessage } from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'

const sendTextMock = vi.mocked(sendText)
const downloadMediaMock = vi.mocked(downloadMedia)
const uploadAndExtractMock = vi.mocked(uploadAndExtract)
const rateLimitMock = vi.mocked(checkInboxUploadRateLimit)
const appendHistoryMock = vi.mocked(appendProcessingHistory)

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    direction: 'inbound',
    wamid: 'wamid.IN1',
    sender_phone_hash: 'hash-1',
    phone_link_id: 'link-1',
    conversation_id: 'conv-1',
    message_type: 'image',
    body_text: 'lunch med kund',
    media_id: 'media-1',
    media_mime: 'image/jpeg',
    media_sha256: null,
    media_filename: null,
    raw_payload: { from: '46701234567' },
    processing_status: 'received',
    attempts: 0,
    error_message: null,
    inbox_item_id: null,
    delivery_status: null,
    correlation_id: 'corr-1',
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z',
    ...overrides,
  }
}

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    user_id: 'user-1',
    phone_hash: 'hash-1',
    phone_enc: 'enc',
    phone_masked: '+46 70 *** ** 67',
    wa_profile_name: null,
    default_company_id: null,
    last_company_id: null,
    verified_at: '2026-08-01T09:00:00Z',
    revoked_at: null,
    muted_at: null,
    last_message_at: null,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
    ...overrides,
  }
}

function lastUpdate(findCalls: (table: string, method: string) => unknown[][]): Record<string, unknown> {
  const updates = findCalls('whatsapp_messages', 'update')
  return updates[updates.length - 1][0] as Record<string, unknown>
}

describe('processInboundMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT' })
    rateLimitMock.mockResolvedValue({ ok: true })
    downloadMediaMock.mockResolvedValue({
      buffer: new Uint8Array([1, 2, 3, 4]).buffer,
      mime: 'image/jpeg',
      fileSize: 4,
    })
    uploadAndExtractMock.mockResolvedValue({
      document_id: 'doc-1',
      inbox_item_id: 'item-1',
      status: 'received',
      extracted_data: {
        supplier: { name: 'Espresso House' },
        totals: { total: 450 },
        invoice: { invoiceDate: '2026-07-30' },
      },
      matched_supplier_id: null,
      matched_transaction_id: null,
      extraction_skipped: false,
      skip_reason: null,
      page_count: null,
    } as never)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('happy path: claims, downloads, funnels through uploadAndExtract and acks with M4', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() }) // load row
    enqueue({ data: { id: 'msg-1' } }) // claim
    enqueue({ data: makeLink() }) // load link
    enqueue({ data: [{ company_id: 'company-1' }] }) // sole membership
    enqueue({ data: null }) // sha256 dup check: none
    enqueue({ data: null }) // final markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(markReadWithTyping).toHaveBeenCalledWith('wamid.IN1')
    expect(downloadMediaMock).toHaveBeenCalledWith('media-1')
    expect(uploadAndExtractMock).toHaveBeenCalledTimes(1)
    expect(uploadAndExtractMock).toHaveBeenCalledWith(
      supabase,
      'user-1',
      'company-1',
      expect.objectContaining({ type: 'image/jpeg' }),
      'whatsapp',
      undefined,
      undefined,
      {
        channelMeta: { whatsappMessageId: 'msg-1', caption: 'lunch med kund' },
        actorId: 'whatsapp-inbound',
      },
    )

    const finalUpdate = lastUpdate(findCalls)
    expect(finalUpdate.processing_status).toBe('done')
    expect(finalUpdate.inbox_item_id).toBe('item-1')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const ack = sendTextMock.mock.calls[0][1]
    expect(ack.template).toBe(TEMPLATE.m4Ack)
    expect(ack.to).toBe('46701234567')
    expect(ack.body).toContain('Espresso House')
    expect(ack.body).toContain('450 kr')
    expect(ack.body).toContain('2026-07-30')
  })

  it('sends the empty-extraction M4 variant when no total was read', async () => {
    uploadAndExtractMock.mockResolvedValue({
      document_id: 'doc-1',
      inbox_item_id: 'item-1',
      extracted_data: { supplier: { name: null }, totals: { total: null }, invoice: {} },
    } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: null })
    enqueue({ data: null })

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m4AckEmpty)
  })

  it('does nothing when the claim is lost (already processing)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: null }) // claim matched no row

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(downloadMediaMock).not.toHaveBeenCalled()
    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('rejects disallowed MIME types with M15, skipped, and no download', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow({ media_mime: 'video/mp4', message_type: 'document' }) })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: null }) // markStatus skipped

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(downloadMediaMock).not.toHaveBeenCalled()
    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m15Unsupported)
    expect(lastUpdate(findCalls).processing_status).toBe('skipped')
  })

  it('multi-company sender without a default gets M6 fallback and no item', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: [{ company_id: 'company-1' }, { company_id: 'company-2' }] })
    enqueue({ data: null }) // markStatus skipped

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(downloadMediaMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m6NoDefaultCompany)
    expect(lastUpdate(findCalls).processing_status).toBe('skipped')
  })

  it('uses the default company when set and still a member', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink({ default_company_id: 'company-7' }) })
    enqueue({ data: { company_id: 'company-7' } }) // membership check for default
    enqueue({ data: null }) // dup check
    enqueue({ data: null }) // markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(uploadAndExtractMock).toHaveBeenCalledWith(
      supabase,
      'user-1',
      'company-7',
      expect.anything(),
      'whatsapp',
      undefined,
      undefined,
      expect.anything(),
    )
  })

  it('rate limit: drops with M17 once, records RateLimitedDropped, never a retryable status', async () => {
    rateLimitMock.mockResolvedValue({ ok: false, scope: 'minute', retryAfterSec: 60 })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: null }) // M17 notice check: none sent yet
    enqueue({ data: null }) // markStatus skipped

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(appendHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'RateLimitedDropped', companyId: 'company-1' }),
    )
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m17RateLimited)
    expect(downloadMediaMock).not.toHaveBeenCalled()
    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(lastUpdate(findCalls).processing_status).toBe('skipped')
  })

  it('rate limit: stays silent when an M17 already went out inside the window', async () => {
    rateLimitMock.mockResolvedValue({ ok: false, scope: 'minute', retryAfterSec: 60 })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: { id: 'earlier-m17' } }) // notice already sent
    enqueue({ data: null }) // markStatus skipped

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('exact sha256 duplicate: M4-duplicate ack and no item created', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: { id: 'existing-doc' } }) // dup found
    enqueue({ data: null }) // markStatus skipped

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m4Duplicate)
    expect(lastUpdate(findCalls).processing_status).toBe('skipped')
  })

  it('wraps failures: error status + error_message + a single M18', async () => {
    downloadMediaMock.mockRejectedValue(new GraphApiError('Media download failed (500)', 500))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: null }) // markStatus error

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    const finalUpdate = lastUpdate(findCalls)
    expect(finalUpdate.processing_status).toBe('error')
    expect(String(finalUpdate.error_message)).toContain('download failed')
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m18Error)
  })

  it('suppresses M18 on re-claims (attempts > 1)', async () => {
    downloadMediaMock.mockRejectedValue(new GraphApiError('still failing'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow({ attempts: 1 }) })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: null }) // markStatus error

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(lastUpdate(findCalls).processing_status).toBe('error')
    expect(sendTextMock).not.toHaveBeenCalled()
  })
})
