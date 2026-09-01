import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createQueuedMockSupabase, createMockRequest } from '@/tests/helpers'

/**
 * PII boundary for the two inbound-mail behandlingshistorik events.
 *
 * RateLimitedDropped and AttachmentsTruncated used to carry the raw sender
 * address and the mail subject. Both were harmless only by accident: the types
 * were missing from processing_event_types, so the FK rejected every insert.
 * Registering them (migration 20260901110000) switches the writes on, and
 * processing_history is append-only, UPDATE-blocked by trigger, and excluded
 * from the archive's erasure path, so the payloads must stay pseudonymous:
 * lib/processing-history/append.ts only pattern-matches personnummer/orgnr
 * shapes and would happily persist an email address.
 */

vi.mock('@/extensions/general/invoice-inbox/lib/resend-inbound', async () => {
  const actual = await vi.importActual<typeof import('@/extensions/general/invoice-inbox/lib/resend-inbound')>(
    '@/extensions/general/invoice-inbox/lib/resend-inbound'
  )
  return {
    ...actual,
    verifyInboundWebhook: vi.fn(),
    fetchReceivingEmail: vi.fn(),
    fetchInboundAttachment: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/extensions/general/invoice-inbox/lib/upload-and-extract', async () => {
  const actual = await vi.importActual<typeof import('@/extensions/general/invoice-inbox/lib/upload-and-extract')>(
    '@/extensions/general/invoice-inbox/lib/upload-and-extract'
  )
  return { ...actual, uploadAndExtract: vi.fn() }
})

vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn(),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-id'),
}))

import { verifyInboundWebhook, fetchReceivingEmail, fetchInboundAttachment } from '@/extensions/general/invoice-inbox/lib/resend-inbound'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createClient } from '@supabase/supabase-js'

const webhookRoute = invoiceInboxExtension.apiRoutes!.find(
  (r) => r.method === 'POST' && r.path === '/inbound'
)!

const SENDER = 'anna.andersson@leverantoren.se'
const SUBJECT = 'Faktura till Anna Andersson'

function makeAttachment(i: number) {
  return {
    id: `att_${i}`,
    filename: `invoice-${i}.pdf`,
    size: 1000,
    content_type: 'application/pdf',
    content_id: `cid${i}`,
    content_disposition: 'attachment',
  }
}

function mockReceivedEvent(attachmentCount: number) {
  return {
    type: 'email.received' as const,
    created_at: '2026-09-01T10:00:00Z',
    data: {
      email_id: 'aa1c1c6e-7f2d-4a1e-9f0a-6d5b7c8e9f01',
      created_at: '2026-09-01T10:00:00Z',
      from: SENDER,
      to: ['acme-ab-x7f2@arcim.io'],
      cc: [],
      bcc: [],
      subject: SUBJECT,
      message_id: '<msg-id@leverantoren.se>',
      attachments: Array.from({ length: attachmentCount }, (_, i) => makeAttachment(i)),
    },
  }
}

function mockFullEmail(attachmentCount: number) {
  return {
    object: 'email',
    id: 'aa1c1c6e-7f2d-4a1e-9f0a-6d5b7c8e9f01',
    to: ['acme-ab-x7f2@arcim.io'],
    from: SENDER,
    created_at: '2026-09-01T10:00:00Z',
    subject: SUBJECT,
    bcc: null,
    cc: null,
    reply_to: null,
    html: null,
    text: 'Faktura bifogad',
    headers: {},
    message_id: '<msg-id@leverantoren.se>',
    raw: null,
    attachments: Array.from({ length: attachmentCount }, (_, i) => makeAttachment(i)),
  }
}

/** The payload of the single history event of `eventType`, or undefined. */
function historyPayload(eventType: string): Record<string, unknown> | undefined {
  const call = vi
    .mocked(appendProcessingHistory)
    .mock.calls.find(([input]) => input.eventType === eventType)
  return call?.[0].payload
}

describe('POST /inbound behandlingshistorik payloads', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_INBOUND_DOMAIN = 'arcim.io'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    vi.mocked(appendProcessingHistory).mockResolvedValue('event-id')
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('records RateLimitedDropped without the sender address or the subject', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent(3) as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(mockFullEmail(3) as never)
    vi.mocked(checkInboxUploadRateLimit).mockResolvedValue({
      ok: false,
      scope: 'day',
      retryAfterSec: 3600,
    } as never)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    vi.mocked(createClient).mockReturnValue(supabase as never)

    const res = await webhookRoute.handler(
      createMockRequest('/inbound', { method: 'POST', body: {} })
    )
    const body = await res.json()
    expect(body.data.reason).toBe('rate_limited')

    const payload = historyPayload('RateLimitedDropped')
    expect(payload).toEqual({ scope: 'day', retry_after_sec: 3600, attachment_count: 3 })
    expect(JSON.stringify(payload)).not.toContain(SENDER)
    expect(JSON.stringify(payload)).not.toContain(SUBJECT)
  })

  it('records AttachmentsTruncated without the sender address or the subject', async () => {
    // 21 attachments: one over the 20-per-email cap.
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent(21) as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(mockFullEmail(21) as never)
    vi.mocked(checkInboxUploadRateLimit).mockResolvedValue({ ok: true } as never)
    // Each kept attachment dead-ends in the per-attachment catch, which is
    // enough: the truncation event is appended before the loop starts.
    vi.mocked(fetchInboundAttachment).mockRejectedValue(new Error('download disabled in test'))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    vi.mocked(createClient).mockReturnValue(supabase as never)

    const res = await webhookRoute.handler(
      createMockRequest('/inbound', { method: 'POST', body: {} })
    )
    expect(res.status).toBe(200)

    const payload = historyPayload('AttachmentsTruncated')
    expect(payload).toEqual({ total: 21, processed: 20, dropped: 1 })
    expect(JSON.stringify(payload)).not.toContain(SENDER)
    expect(JSON.stringify(payload)).not.toContain(SUBJECT)
  })

  it('keeps the mail traceable through the Resend email id', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent(1) as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(mockFullEmail(1) as never)
    vi.mocked(checkInboxUploadRateLimit).mockResolvedValue({
      ok: false,
      scope: 'minute',
      retryAfterSec: 60,
    } as never)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    vi.mocked(createClient).mockReturnValue(supabase as never)

    await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))

    // Dropping `from` / `subject` costs nothing for triage: the correlation id
    // is the Resend email id, and invoice_inbox_items holds the rest.
    const [input] = vi
      .mocked(appendProcessingHistory)
      .mock.calls.find(([i]) => i.eventType === 'RateLimitedDropped')!
    expect(input.correlationId).toBe('aa1c1c6e-7f2d-4a1e-9f0a-6d5b7c8e9f01')
    expect(input.aggregateId).toBe('aa1c1c6e-7f2d-4a1e-9f0a-6d5b7c8e9f01')
  })
})
