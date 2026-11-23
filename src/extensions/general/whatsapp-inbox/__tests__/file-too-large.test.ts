import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A file over our own 10 MB cap (MAX_MEDIA_BYTES) is the sender's file, not
 * our failure. It got M18 ("Något gick fel ... Försök igen om en stund"),
 * which no retry can make true, and an error log (2026-10-30, 2026-11-16).
 * It gets a reply that says the file is too large and names the limit, and
 * a warning. Every other intake failure keeps M18 and its error.
 *
 * The real downloadMedia runs here, against a stubbed Graph API: the size
 * guard that refuses the file is the one in production.
 */

const logger = vi.hoisted(() => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  l.child.mockReturnValue(l)
  return l
})
vi.mock('@/lib/logger', () => ({ createLogger: () => logger }))

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null }),
    markReadWithTyping: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('@/extensions/general/invoice-inbox/lib/upload-and-extract', () => ({ uploadAndExtract: vi.fn() }))
vi.mock('@/lib/rate-limits/inbox', () => ({ checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/rate-limits/agent', () => ({ checkAgentRateLimit: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn().mockResolvedValue('event-1') }))
vi.mock('@/lib/core/documents/document-service', () => ({ computeSHA256: vi.fn().mockResolvedValue('sha-abc') }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))

import { sendText, MAX_MEDIA_BYTES } from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { processInboundMessage } from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'

const sendTextMock = vi.mocked(sendText)
const fetchMock = vi.fn()

const row = {
  id: 'msg-1',
  direction: 'inbound',
  wamid: 'wamid.IN1',
  sender_phone_hash: 'hash-1',
  phone_link_id: 'link-1',
  conversation_id: 'conv-1',
  message_type: 'document',
  body_text: null,
  media_id: 'media-1',
  media_mime: 'application/pdf',
  media_sha256: null,
  media_filename: 'avtal.pdf',
  raw_payload: { from: '46701234567' },
  processing_status: 'received',
  attempts: 0,
  error_message: null,
  inbox_item_id: null,
  delivery_status: null,
  correlation_id: 'corr-1',
  acked_at: null,
  created_at: '2026-11-16T11:13:30Z',
  updated_at: '2026-11-16T11:13:30Z',
}

const link = {
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
}

const conversation = {
  id: 'conv-1',
  phone_link_id: 'link-1',
  state: 'idle',
  context: {},
  company_id: null,
  service_window_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  debounce_until: new Date().toISOString(),
  pending_ack: true,
  last_inbound_at: null,
  last_outbound_at: null,
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
}

/** A media row up to the download, then the failure path's status write. */
function intakeUpToDownload() {
  const queued = createQueuedMockSupabase()
  queued.enqueue({ data: row }) // load row
  queued.enqueue({ data: { id: 'msg-1' } }) // claim
  queued.enqueue({ data: link }) // load link
  queued.enqueue({ data: conversation }) // load conversation
  queued.enqueue({ data: [{ company_id: 'company-1' }] }) // sole membership
  queued.enqueue({ data: [] }) // drain: nothing expired
  queued.enqueue({ data: [] }) // drain: nothing parked behind an old company question
  queued.enqueue({ data: null }) // no inbox item yet
  queued.enqueue({ data: null }) // markStatus error
  return queued
}

function lastStatusUpdate(findCalls: (table: string, method: string) => unknown[][]): Record<string, unknown> {
  const updates = findCalls('whatsapp_messages', 'update')
  return updates[updates.length - 1][0] as Record<string, unknown>
}

describe('processInboundMessage: a file over the size limit', () => {
  const env = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    process.env.WHATSAPP_ACCESS_TOKEN = 'token-1'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone-1'
    sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = { ...env }
  })

  it('tells the sender the file is too large and the limit, and logs a warning, not an error', async () => {
    // Meta's media lookup states the size: a 25 MB PDF.
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ url: 'https://lookaside.example/m1', mime_type: 'application/pdf', file_size: 25 * 1024 * 1024 }),
      { status: 200 },
    ))
    const { supabase, findCalls } = intakeUpToDownload()

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(lastStatusUpdate(findCalls).processing_status).toBe('error')
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const reply = sendTextMock.mock.calls[0][1]
    expect(reply.template).toBe(TEMPLATE.m29FileTooLarge)
    expect(reply.body).toMatch(/för stor/)
    expect(reply.body).toMatch(new RegExp(`\\b${MAX_MEDIA_BYTES / (1024 * 1024)} MB\\b`))
    expect(reply.body).not.toMatch(/försök igen/i)
    expect(logger.warn).toHaveBeenCalledWith('WhatsApp file over the size limit', expect.objectContaining({ messageId: 'msg-1' }))
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('any other failure keeps M18 and its error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream', { status: 500 }))
    const queued = intakeUpToDownload()
    queued.enqueue({ data: null }) // no M18 sent yet

    await processInboundMessage(queued.supabase as unknown as SupabaseClient, 'msg-1')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m18Error)
    expect(logger.error).toHaveBeenCalledWith('WhatsApp intake processing failed', expect.objectContaining({ message: 'Media lookup failed (500)' }),
      expect.objectContaining({ messageId: 'msg-1' }))
    expect(logger.warn).not.toHaveBeenCalledWith('WhatsApp file over the size limit', expect.anything())
  })
})
