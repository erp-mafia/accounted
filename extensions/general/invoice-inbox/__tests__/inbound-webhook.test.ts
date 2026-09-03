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

// uploadAndExtract does real storage + Bedrock work; these tests only assert
// what the webhook hands it. Constants and the pure HTML helpers stay real so
// MIME gating and body-document building run genuine code.
vi.mock('@/extensions/general/invoice-inbox/lib/upload-and-extract', async () => {
  const actual = await vi.importActual<typeof import('@/extensions/general/invoice-inbox/lib/upload-and-extract')>(
    '@/extensions/general/invoice-inbox/lib/upload-and-extract'
  )
  return { ...actual, uploadAndExtract: vi.fn() }
})

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

// The webhook appends one InboundMailReceived event per mail and inbox
// (#2181); keep the history write off the network and observable.
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-id'),
}))

import { verifyInboundWebhook, fetchReceivingEmail, fetchInboundAttachment } from '@/extensions/general/invoice-inbox/lib/resend-inbound'
import { uploadAndExtract } from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import { createClient } from '@supabase/supabase-js'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'

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
    enqueue({ data: null }) // body-document dedupe check finds nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-9' } as never)
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
    // A body-only mail now becomes a text/html document for company-9:
    // proves the custom-domain routing reached the processing stage.
    expect(body.data.reason).toBe('email_body')
    expect(vi.mocked(uploadAndExtract).mock.calls[0][2]).toBe('company-9')
  })

  it('does not carry a shared-address tag onto a custom-domain match (#2129)', async () => {
    // The tagged shared address is retired, so the custom domain resolves the
    // company. The +lev tag belonged to the retired address and must not stamp
    // the custom-domain company's row.
    const to = ['old-inbox-abcd+lev@arcim.io', 'fakturor@hansbolag.example']
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent({ to, attachments: [] }) as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-old', company_id: 'company-old', status: 'deprecated' } }) // shared lookup
    enqueue({ data: [{ company_id: 'company-9', domain: 'hansbolag.example' }] }) // verified domain
    enqueue({ data: { created_by: 'user-owner-9' } }) // company owner
    enqueue({ data: null }) // body-document dedupe check finds nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-9' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to,
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
    expect(body.data.reason).toBe('email_body')
    const [, , companyId, , , emailMeta] = vi.mocked(uploadAndExtract).mock.calls[0]
    expect(companyId).toBe('company-9')
    expect(emailMeta?.kindHint).toBeNull()
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
    enqueue({ data: null }) // body-document dedupe check finds nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-1' } as never)
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
    expect(body.data.reason).toBe('email_body')
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

  it('routes a +lev plus-address to the base inbox and hints supplier_invoice (#2129)', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ to: ['Acme-AB-x7f2+LEV@arcim.io'] }) as never,
    )
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // per-attachment dup check finds nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-lev-1' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['Acme-AB-x7f2+LEV@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Faktura',
      bcc: null,
      cc: null,
      reply_to: null,
      html: null,
      text: 'Se bifogad faktura',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [
        { id: 'att_1', filename: 'faktura.pdf', size: 100, content_type: 'application/pdf', content_id: 'cid', content_disposition: 'attachment' },
      ],
    } as never)
    vi.mocked(fetchInboundAttachment).mockResolvedValue({
      id: 'att_1',
      filename: 'faktura.pdf',
      contentType: 'application/pdf',
      buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer as ArrayBuffer,
    })

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.results[0].inbox_item_id).toBe('item-lev-1')

    // The lookup used the local part WITHOUT the tag; before the split this
    // mail 404ed as "Address not found".
    const lookup = calls.find((c) => c.table === 'company_inboxes' && c.method === 'eq')
    expect(lookup?.args).toEqual(['local_part', 'acme-ab-x7f2'])

    const [, , , , , emailMeta] = vi.mocked(uploadAndExtract).mock.calls[0]
    expect(emailMeta?.kindHint).toBe('supplier_invoice')
  })

  it('routes an unknown plus-tag with no kind hint instead of dropping the mail (#2129)', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ to: ['acme-ab-x7f2+faktura@arcim.io'], attachments: [] }) as never,
    )
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // body-document dup check finds nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-body-1' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2+faktura@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Kvitto',
      bcc: null,
      cc: null,
      reply_to: null,
      html: '<p>Kvitto 120 kr</p>',
      text: 'Kvitto 120 kr',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [],
    } as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.reason).toBe('email_body')

    const lookup = calls.find((c) => c.table === 'company_inboxes' && c.method === 'eq')
    expect(lookup?.args).toEqual(['local_part', 'acme-ab-x7f2'])

    const [, , , , , emailMeta] = vi.mocked(uploadAndExtract).mock.calls[0]
    expect(emailMeta?.kindHint).toBeNull()
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

  it('stores the mail body as a text/html document when the mail has no attachments', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ attachments: [] }) as never
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // body-document dedupe check finds nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-body-1' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Kvitto på ditt köp',
      bcc: null,
      cc: null,
      reply_to: null,
      html: '<div>Att betala: <b>1 234,56 kr</b></div>',
      text: 'Att betala: 1 234,56 kr',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [],
    } as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.reason).toBe('email_body')
    expect(body.data.processed).toBe(1)
    expect(body.data.inbox_item_id).toBe('item-body-1')
    expect(fetchInboundAttachment).not.toHaveBeenCalled()

    const [, , companyId, file, source] = vi.mocked(uploadAndExtract).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(source).toBe('email')
    expect(file.type).toBe('text/html')
    expect(file.name).toMatch(/^mail-.*\.html$/)
    const stored = new TextDecoder().decode(new Uint8Array(file.buffer))
    expect(stored.toLowerCase().startsWith('<!doctype html')).toBe(true)
    expect(stored).toContain('<div>Att betala: <b>1 234,56 kr</b></div>')
  })

  it('keeps the error row for a no-attachment mail with an empty body', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ attachments: [] }) as never
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // error-row insert
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Tomt mejl',
      bcc: null,
      cc: null,
      reply_to: null,
      html: null,
      text: '  ',
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
    expect(uploadAndExtract).not.toHaveBeenCalled()
  })

  it('does not duplicate the body document when Resend retries the webhook', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ attachments: [] }) as never
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: { id: 'existing-body-item' } }) // dedupe check finds the first delivery's row
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Kvitto',
      bcc: null,
      cc: null,
      reply_to: null,
      html: '<div>Kvitto</div>',
      text: null,
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [],
    } as never)

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.reason).toBe('email_body_duplicate')
    expect(body.data.inbox_item_id).toBe('existing-body-item')
    expect(uploadAndExtract).not.toHaveBeenCalled()
  })

  it('falls back to the error row when the body document upload fails', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ attachments: [] }) as never
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // dedupe check finds nothing
    enqueue({ data: null }) // fallback error-row insert
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockRejectedValue(new Error('storage down'))
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Kvitto',
      bcc: null,
      cc: null,
      reply_to: null,
      html: '<div>Kvitto</div>',
      text: null,
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

  it('accepts a text/html attachment and wraps it into a full document', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // per-attachment dup check finds nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-html-1' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Faktura',
      bcc: null,
      cc: null,
      reply_to: null,
      html: null,
      text: 'Se bifogad faktura',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [
        { id: 'att_html', filename: 'faktura.html', size: 100, content_type: 'text/html', content_id: 'cid', content_disposition: 'attachment' },
      ],
    } as never)
    vi.mocked(fetchInboundAttachment).mockResolvedValue({
      id: 'att_html',
      filename: 'faktura.html',
      contentType: 'text/html',
      buffer: new TextEncoder().encode('<div>Faktura 123: 500 kr</div>').buffer as ArrayBuffer,
    })

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.results[0].inbox_item_id).toBe('item-html-1')

    const [, , , file] = vi.mocked(uploadAndExtract).mock.calls[0]
    expect(file.type).toBe('text/html')
    const stored = new TextDecoder().decode(new Uint8Array(file.buffer))
    expect(stored.toLowerCase().startsWith('<!doctype html')).toBe(true)
    expect(stored).toContain('<div>Faktura 123: 500 kr</div>')
  })

  it('still rejects attachment types outside the email allowlist, keeping the sender kind hint on the error row', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ to: ['acme-ab-x7f2+ver@arcim.io'] }) as never,
    )
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // per-attachment dup check finds nothing
    enqueue({ data: null }) // rejection-row insert
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2+ver@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Zip',
      bcc: null,
      cc: null,
      reply_to: null,
      html: null,
      text: 'Body',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [
        { id: 'att_zip', filename: 'faktura.zip', size: 100, content_type: 'application/zip', content_id: 'cid', content_disposition: 'attachment' },
      ],
    } as never)
    vi.mocked(fetchInboundAttachment).mockResolvedValue({
      id: 'att_zip',
      filename: 'faktura.zip',
      contentType: 'application/zip',
      buffer: new ArrayBuffer(8),
    })

    const request = createMockRequest('/inbound', { method: 'POST', body: {} })
    const res = await webhookRoute.handler(request)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.results[0].error).toBe('Unsupported type application/zip')
    expect(uploadAndExtract).not.toHaveBeenCalled()

    // The rejected row still carries what the sender said (#2129), so it can
    // be found under the Underlag filter like any other inbox item.
    const rejection = calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'insert')
    expect(rejection?.args[0]).toMatchObject({ status: 'error', kind_hint: 'receipt' })
  })
})

/** Every InboundMailReceived append, in order. */
function receivedEvents() {
  return vi
    .mocked(appendProcessingHistory)
    .mock.calls.map(([input]) => input)
    .filter((input) => input.eventType === 'InboundMailReceived')
}

function fullEmailFor(to: string[], attachments: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    object: 'email',
    id: 'em_123',
    to,
    from: 'billing@supplier.com',
    created_at: '2026-04-20T10:00:00Z',
    subject: 'Faktura',
    bcc: null,
    cc: null,
    reply_to: null,
    html: null,
    text: 'Se bifogad faktura',
    headers: {},
    message_id: '<msg@x>',
    raw: null,
    attachments,
    ...overrides,
  }
}

const PDF_ATTACHMENT = {
  id: 'att_1',
  filename: 'faktura.pdf',
  size: 100,
  content_type: 'application/pdf',
  content_id: 'cid',
  content_disposition: 'attachment',
}

const PDF_DOWNLOAD = {
  id: 'att_1',
  filename: 'faktura.pdf',
  contentType: 'application/pdf',
  buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer as ArrayBuffer,
}

describe('POST /inbound with several recipients (#2181)', () => {
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

  it('files a mail sent to +lev and +ver of the same inbox once, with no kind hint', async () => {
    const to = ['acme-ab-x7f2+lev@arcim.io', 'acme-ab-x7f2+ver@arcim.io']
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent({ to }) as never)
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } }) // one inbox lookup
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // per-attachment dup check finds nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-1' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(to, [PDF_ATTACHMENT]) as never)
    vi.mocked(fetchInboundAttachment).mockResolvedValue(PDF_DOWNLOAD)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.processed).toBe(1)
    expect(body.data.results).toEqual([{ attachment_id: 'att_1', inbox_item_id: 'item-1' }])

    // One inbox lookup, one upload, no hint: the sender said two things.
    expect(calls.filter((c) => c.table === 'company_inboxes' && c.method === 'eq')).toHaveLength(1)
    expect(uploadAndExtract).toHaveBeenCalledTimes(1)
    const [, , , , , emailMeta] = vi.mocked(uploadAndExtract).mock.calls[0]
    expect(emailMeta?.kindHint).toBeNull()

    const events = receivedEvents()
    expect(events).toHaveLength(1)
    expect(events[0].companyId).toBe('company-1')
    expect(events[0].correlationId).toBe('em_123')
    expect(events[0].payload).toMatchObject({
      recipients: to,
      tags: ['lev', 'ver'],
      inbox_id: 'inbox-1',
      kind_hint: null,
      tag_conflict: true,
      outcome: 'attachments',
      attachment_count: 1,
      attachments: [{ id: 'att_1', outcome: 'filed', inbox_item_id: 'item-1' }],
    })
    expect(JSON.stringify(events[0].payload)).not.toContain('billing@supplier.com')
    expect(JSON.stringify(events[0].payload)).not.toContain('Faktura')
  })

  it('files a mail addressed to two inboxes once per inbox, deduped per company', async () => {
    const to = ['acme-ab-x7f2+lev@arcim.io', 'beta-ab-q9z1@arcim.io']
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent({ to }) as never)
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { id: 'inbox-2', company_id: 'company-2', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: { created_by: 'user-owner-2' } })
    enqueue({ data: null }) // company-1 dup check
    enqueue({ data: null }) // company-2 dup check
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract)
      .mockResolvedValueOnce({ inbox_item_id: 'item-c1' } as never)
      .mockResolvedValueOnce({ inbox_item_id: 'item-c2' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(to, [PDF_ATTACHMENT]) as never)
    vi.mocked(fetchInboundAttachment).mockResolvedValue(PDF_DOWNLOAD)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.processed).toBe(2)
    expect(body.data.targets).toEqual([
      { company_id: 'company-1', processed: 1, results: [{ attachment_id: 'att_1', inbox_item_id: 'item-c1' }] },
      { company_id: 'company-2', processed: 1, results: [{ attachment_id: 'att_1', inbox_item_id: 'item-c2' }] },
    ])

    expect(uploadAndExtract).toHaveBeenCalledTimes(2)
    expect(vi.mocked(uploadAndExtract).mock.calls[0][2]).toBe('company-1')
    expect(vi.mocked(uploadAndExtract).mock.calls[0][5]?.kindHint).toBe('supplier_invoice')
    expect(vi.mocked(uploadAndExtract).mock.calls[1][2]).toBe('company-2')
    expect(vi.mocked(uploadAndExtract).mock.calls[1][5]?.kindHint).toBeNull()

    // The idempotency lookup is company-scoped: the second inbox's copy is
    // not "already processed" because the first inbox filed it.
    const dupChecks = calls.filter(
      (c) => c.table === 'invoice_inbox_items' && c.method === 'eq' && c.args[0] === 'company_id',
    )
    expect(dupChecks.map((c) => c.args[1])).toEqual(['company-1', 'company-2'])

    const events = receivedEvents()
    expect(events.map((e) => e.companyId)).toEqual(['company-1', 'company-2'])
    expect(events[0].payload).toMatchObject({ recipients: ['acme-ab-x7f2+lev@arcim.io'], tags: ['lev'], kind_hint: 'supplier_invoice', tag_conflict: false })
    expect(events[1].payload).toMatchObject({ recipients: ['beta-ab-q9z1@arcim.io'], tags: [], kind_hint: null, inbox_id: 'inbox-2' })
  })

  it('skips a retired address in the list and still files for the active one', async () => {
    const to = ['old-inbox-abcd+lev@arcim.io', 'acme-ab-x7f2+ver@arcim.io']
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent({ to, attachments: [] }) as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-old', company_id: 'company-old', status: 'deprecated' } })
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // body-document dedupe check
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-body' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(to, [], { html: '<p>Kvitto</p>' }) as never)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.reason).toBe('email_body')
    expect(vi.mocked(uploadAndExtract).mock.calls[0][2]).toBe('company-1')
    // The retired address's tag does not leak onto the active inbox's hint.
    expect(vi.mocked(uploadAndExtract).mock.calls[0][5]?.kindHint).toBe('receipt')
    expect(receivedEvents()[0].payload).toMatchObject({ outcome: 'email_body', inbox_item_id: 'item-body' })
  })

  it('records a duplicate outcome when Resend retries the webhook', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: { id: 'existing-item-1' } }) // dup check finds the first delivery's row
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(['acme-ab-x7f2@arcim.io'], [PDF_ATTACHMENT]) as never)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    expect(res.status).toBe(200)
    expect(receivedEvents()[0].payload).toMatchObject({
      attachments: [{ id: 'att_1', outcome: 'duplicate', inbox_item_id: 'existing-item-1' }],
    })
  })

  it('records a rejected outcome for an attachment type outside the allowlist', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // dup check
    enqueue({ data: { id: 'rejected-row-1' } }) // rejection-row insert returns its id
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(
      fullEmailFor(['acme-ab-x7f2@arcim.io'], [{ ...PDF_ATTACHMENT, id: 'att_zip', filename: 'x.zip', content_type: 'application/zip' }]) as never,
    )
    vi.mocked(fetchInboundAttachment).mockResolvedValue({
      id: 'att_zip',
      filename: 'x.zip',
      contentType: 'application/zip',
      buffer: new ArrayBuffer(8),
    })

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    expect(res.status).toBe(200)
    expect(receivedEvents()[0].payload).toMatchObject({
      attachments: [
        { id: 'att_zip', outcome: 'rejected', reason: 'unsupported_type', mime: 'application/zip', inbox_item_id: 'rejected-row-1' },
      ],
    })
  })

  it('keeps an attachment whose processing threw as an error row and records it as failed', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent({ to: ['acme-ab-x7f2+lev@arcim.io'] }) as never)
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // dup check
    enqueue({ data: null }) // post-failure lookup: the upload never made its row
    enqueue({ data: { id: 'failed-row-1' } }) // error-row insert
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(['acme-ab-x7f2+lev@arcim.io'], [PDF_ATTACHMENT]) as never)
    vi.mocked(fetchInboundAttachment).mockRejectedValue(new Error('Download URL returned 503 for attachment att_1'))

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.results[0].error).toBe('Download URL returned 503 for attachment att_1')

    // Before #2181 this path wrote nothing: the mail was accepted, answered
    // 200 and gone. Now the attachment is an error row the user can see.
    const insert = calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({
      status: 'error',
      resend_email_id: 'em_123',
      resend_attachment_id: 'att_1',
      kind_hint: 'supplier_invoice',
    })
    expect((insert?.args[0] as { error_message: string }).error_message).toMatch(/^Bilagan kunde inte tas emot: Download URL returned 503/)

    expect(receivedEvents()[0].payload).toMatchObject({
      attachments: [{ id: 'att_1', outcome: 'failed', inbox_item_id: 'failed-row-1' }],
    })
  })

  it('does not write a second error row when the upload made its own row before throwing', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // dup check
    enqueue({ data: { id: 'partial-row-1' } }) // post-failure lookup finds the upload's row
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(['acme-ab-x7f2@arcim.io'], [PDF_ATTACHMENT]) as never)
    vi.mocked(fetchInboundAttachment).mockResolvedValue(PDF_DOWNLOAD)
    vi.mocked(uploadAndExtract).mockRejectedValue(new Error('extraction timed out'))

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    expect(res.status).toBe(200)
    expect(calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'insert')).toBeUndefined()
    expect(receivedEvents()[0].payload).toMatchObject({
      attachments: [{ id: 'att_1', outcome: 'failed', inbox_item_id: 'partial-row-1' }],
    })
  })

  it('records the rate-limited drop on the mail record too', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    vi.mocked(checkInboxUploadRateLimit).mockResolvedValueOnce({ ok: false, scope: 'minute', retryAfterSec: 60 } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(['acme-ab-x7f2@arcim.io'], [PDF_ATTACHMENT]) as never)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(body.data.reason).toBe('rate_limited')
    expect(vi.mocked(appendProcessingHistory).mock.calls.map(([i]) => i.eventType)).toEqual([
      'RateLimitedDropped',
      'InboundMailReceived',
    ])
    expect(receivedEvents()[0].payload).toMatchObject({ outcome: 'rate_limited', attachments: [] })
  })
})
