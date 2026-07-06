import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { ResendSignatureError } from '@/extensions/general/invoice-inbox/lib/resend-inbound'
import { createQueuedMockSupabase, createMockRequest } from '@/tests/helpers'

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

// applyDomainStatusFromWebhook confirms the receiving capability with Resend
// before flipping a row to verified: keep that lookup off the network.
const { domainsMock } = vi.hoisted(() => ({
  domainsMock: {
    get: vi.fn(),
  },
}))
vi.mock('resend', () => ({
  Resend: class {
    domains = domainsMock
  },
}))

// Rate limiter is a thin RPC wrapper; bypass it so the queued-mock sequence
// in each test doesn't have to account for the extra Supabase call.
vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

import { verifyInboundWebhook, fetchReceivingEmail, fetchInboundAttachment } from '@/extensions/general/invoice-inbox/lib/resend-inbound'
import { createClient } from '@supabase/supabase-js'

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find((r) => r.method === method && r.path === path)!
}

const webhookRoute = findRoute('POST', '/inbound')

function mockReceivedEvent(overrides?: Record<string, unknown>) {
  return {
    type: 'email.received' as const,
    created_at: '2026-04-20T10:00:00Z',
    data: {
      email_id: 'em_123',
      created_at: '2026-04-20T10:00:00Z',
      from: 'billing@supplier.com',
      to: ['acme-ab-x7f2@arcim.io'],
      cc: [],
      bcc: [],
      subject: 'Invoice #5678',
      message_id: '<msg-id@supplier.com>',
      attachments: [
        {
          id: 'att_1',
          filename: 'invoice.pdf',
          size: 12345,
          content_type: 'application/pdf',
          content_id: 'cid1',
          content_disposition: 'attachment',
        },
      ],
      ...overrides,
    },
  }
}

describe('POST /inbound', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_INBOUND_DOMAIN = 'arcim.io'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns 503 when RESEND_INBOUND_DOMAIN is not set', async () => {
    delete process.env.RESEND_INBOUND_DOMAIN
    const request = createMockRequest('/inbound', { method: 'POST', body: { type: 'email.received' } })
    const res = await webhookRoute.handler(request)
    expect(res.status).toBe(503)
  })

  it('returns 401 when signature verification fails', async () => {
    vi.mocked(verifyInboundWebhook).mockImplementation(() => {
      throw new ResendSignatureError('bad sig')
    })
    const request = createMockRequest('/inbound', { method: 'POST', body: { type: 'email.received' } })
    const res = await webhookRoute.handler(request)
    expect(res.status).toBe(401)
  })

  it('ignores non-received events with 200', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue({
      type: 'email.sent',
      created_at: '',
      data: {},
    } as never)
    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    expect(res.status).toBe(200)
  })

  it('returns 404 when no recipient matches our domain or a verified custom domain', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ to: ['random@contoso.com'] }) as never
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] }) // company_inbound_domains lookup finds nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    expect(res.status).toBe(404)
  })

  it('routes mail on a verified custom domain to its company (any local part)', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ to: ['fakturor@hansbolag.example'], attachments: [] }) as never
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ company_id: 'company-9', domain: 'hansbolag.example' }] }) // verified domain
    enqueue({ data: { created_by: 'user-owner-9' } }) // company owner
    enqueue({ data: null }) // no-attachments error-row insert
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['fakturor@hansbolag.example'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Invoice #5678',
      bcc: null,
      cc: null,
      reply_to: null,
      html: null,
      text: 'Body',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [],
    } as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.reason).toBe('no_attachments')
  })

  it('does not route mail for an unverified custom domain', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ to: ['faktura@pending-bolag.example'] }) as never
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    // status='verified' filter means a pending claim never matches
    enqueue({ data: [] })
    vi.mocked(createClient).mockReturnValue(supabase as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    expect(res.status).toBe(404)
  })

  it('prefers the shared-domain address when both shared and custom recipients are present', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({
        to: ['acme-ab-x7f2@arcim.io', 'faktura@hansbolag.example'],
        attachments: [],
      }) as never
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Only the three shared-path queries are enqueued: if the handler also
    // ran the custom-domain lookup, the queue would shift and created_by
    // would resolve to null (500). A 200 proves the shared path won.
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // no-attachments error-row insert
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io', 'faktura@hansbolag.example'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Invoice #5678',
      bcc: null,
      cc: null,
      reply_to: null,
      html: null,
      text: 'Body',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [],
    } as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.reason).toBe('no_attachments')
  })

  it('applies domain.updated events to custom-domain rows', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    domainsMock.get.mockResolvedValue({
      data: {
        id: 'rd_123',
        status: 'verified',
        capabilities: { receiving: 'enabled', sending: 'disabled' },
        records: [],
      },
      error: null,
    })
    vi.mocked(verifyInboundWebhook).mockReturnValue({
      type: 'domain.updated',
      created_at: '2026-07-01T10:00:00Z',
      data: {
        id: 'rd_123',
        name: 'hansbolag.example',
        status: 'verified',
        created_at: '2026-07-01T09:00:00Z',
        region: 'eu-west-1',
        records: [],
      },
    } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', verified_at: null } }) // row by resend_domain_id
    enqueue({ data: null }) // update
    vi.mocked(createClient).mockReturnValue(supabase as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.domain_updated).toBe(true)
  })

  it('returns 404 when the address is not in company_inboxes', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // company_inboxes lookup returns nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    expect(res.status).toBe(404)
  })

  it('returns 410 when the address is deprecated', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'deprecated' } })
    vi.mocked(createClient).mockReturnValue(supabase as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    expect(res.status).toBe(410)
  })

  it('skips already-processed attachments (per-attachment idempotency)', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } }) // inbox lookup
    enqueue({ data: { created_by: 'user-owner-1' } }) // company owner
    enqueue({ data: { id: 'existing-item-1' } }) // per-attachment dup check finds existing row
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Invoice #5678',
      bcc: null,
      cc: null,
      reply_to: null,
      html: null,
      text: 'Body',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [
        { id: 'att_1', filename: 'invoice.pdf', size: 100, content_type: 'application/pdf', content_id: 'cid', content_disposition: 'attachment' },
      ],
    } as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.results[0].duplicate).toBe(true)
    expect(body.data.results[0].inbox_item_id).toBe('existing-item-1')
    expect(fetchInboundAttachment).not.toHaveBeenCalled()
  })

  it('returns 500 when the company has no created_by owner', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: null } }) // company with no owner
    vi.mocked(createClient).mockReturnValue(supabase as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    expect(res.status).toBe(500)
  })

  it('logs an error inbox item when email has no attachments', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ attachments: [] }) as never
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // insert succeeds
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'No attachments here',
      bcc: null,
      cc: null,
      reply_to: null,
      html: null,
      text: 'Body only',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [],
    } as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.reason).toBe('no_attachments')
    expect(fetchInboundAttachment).not.toHaveBeenCalled()
  })
})
