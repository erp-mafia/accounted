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
    // A body-only mail becomes a PDF underlag for company-9: proves the
    // custom-domain routing reached the processing stage.
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

  it('renders the mail body to a PDF underlag when the mail has no attachments (#2751)', async () => {
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

    const [, , companyId, file, source, emailMeta] = vi.mocked(uploadAndExtract).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(source).toBe('email')
    expect(file.type).toBe('application/pdf')
    // Header fields come from the webhook event, the body from the fetched mail.
    expect(file.name).toBe('mail-Invoice__5678.pdf')
    expect(new TextDecoder('latin1').decode(new Uint8Array(file.buffer.slice(0, 5)))).toBe('%PDF-')
    // The message id reaches the inbox row (raw_email_payload) through the
    // same meta as an attachment; the PDF carries it in its header block.
    expect(emailMeta?.messageId).toBe('<msg-id@supplier.com>')
    expect(emailMeta?.bodyText).toBe('Att betala: 1 234,56 kr')
  })

  it('files the body, not the logos, when a forwarded receipt carries only signature images (#2751)', async () => {
    // The reporter's mail: the receipt was the text, the only "attachments"
    // were the inline images of the forwarding signature. Before, the logo
    // was filed and extracted and the body never looked at.
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({
        from: 'anna@example.se',
        subject: 'Fwd: Ditt kvitto',
        message_id: '<fwd-1@example.se>',
        created_at: '2026-09-18T12:03:00Z',
        attachments: [],
      }) as never,
    )
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // body-document dedupe check finds nothing
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-body-2' } as never)
    const receipt =
      '---------- Forwarded message ---------\nFrån: Spotify <no-reply@spotify.com>\nSubject: Ditt kvitto\n\n' +
      'Spotify Premium 119,00 kr\nMoms 25% 23,80 kr\nTotalt 119,00 kr\nOrdernummer 4711-2026\nBetalt med kort som slutar på 1234'
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'anna@example.se',
      created_at: '2026-09-18T12:03:00Z',
      subject: 'Fwd: Ditt kvitto',
      bcc: null,
      cc: null,
      reply_to: null,
      html: `<div>${receipt.replace(/\n/g, '<br>')}</div><img src="cid:logo@x"><img src="cid:pixel@x">`,
      text: receipt,
      headers: {},
      message_id: '<fwd-1@example.se>',
      raw: null,
      attachments: [
        { id: 'att_logo', filename: 'image001.png', size: 18_442, content_type: 'image/png', content_id: 'logo@x', content_disposition: 'inline' },
        { id: 'att_pixel', filename: null, size: 43, content_type: 'image/gif', content_id: 'pixel@x', content_disposition: 'inline' },
      ],
    } as never)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.reason).toBe('email_body')
    expect(body.data.inbox_item_id).toBe('item-body-2')
    // Never downloaded, never a row.
    expect(fetchInboundAttachment).not.toHaveBeenCalled()
    expect(calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'insert')).toBeUndefined()

    const [, , , file] = vi.mocked(uploadAndExtract).mock.calls[0]
    expect(file.type).toBe('application/pdf')
    expect(file.name).toBe('mail-Fwd__Ditt_kvitto.pdf')
    expect(receivedEvents()[0].payload).toMatchObject({
      outcome: 'email_body',
      inbox_item_id: 'item-body-2',
      attachment_count: 2,
      attachments: [
        { id: 'att_logo', outcome: 'ignored', reason: 'signature_image', mime: 'image/png' },
        { id: 'att_pixel', outcome: 'ignored', reason: 'signature_image', mime: 'image/gif' },
      ],
    })
  })

  it('keeps the guard for a mail whose only attachments are signature images and whose text is a note', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({ from: 'anna@example.se', subject: 'Kvitto', message_id: '<note-1@example.se>', attachments: [] }) as never,
    )
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // error-row insert
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'anna@example.se',
      created_at: '2026-09-18T12:03:00Z',
      subject: 'Kvitto',
      bcc: null,
      cc: null,
      reply_to: null,
      html: '<div>Skickat från min iPhone</div><img src="cid:logo@x">',
      text: 'Skickat från min iPhone',
      headers: {},
      message_id: '<note-1@example.se>',
      raw: null,
      attachments: [
        { id: 'att_logo', filename: 'image001.png', size: 18_442, content_type: 'image/png', content_id: 'logo@x', content_disposition: 'inline' },
      ],
    } as never)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.reason).toBe('no_attachments')
    expect(uploadAndExtract).not.toHaveBeenCalled()
    expect(fetchInboundAttachment).not.toHaveBeenCalled()
    const insert = calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({
      status: 'error',
      error_message: 'Mejlet innehöll bara signaturbilder och ingen mejltext att spara som underlag',
      email_body_text: 'Skickat från min iPhone',
      raw_email_payload: { messageId: '<note-1@example.se>' },
    })
    expect(receivedEvents()[0].payload).toMatchObject({
      outcome: 'no_attachments',
      attachments: [{ id: 'att_logo', outcome: 'ignored', reason: 'signature_image' }],
    })
  })

  it('files the document attachment and ignores the signature image next to it', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // per-attachment dup check for the PDF
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-pdf-1' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'billing@supplier.com',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Faktura 5678',
      bcc: null,
      cc: null,
      reply_to: null,
      html: '<p>Se bifogad faktura.</p><img src="cid:logo@x">',
      text: 'Se bifogad faktura.',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [
        { id: 'att_logo', filename: 'logo.png', size: 9_000, content_type: 'image/png', content_id: 'logo@x', content_disposition: 'inline' },
        { id: 'att_1', filename: 'faktura.pdf', size: 100, content_type: 'application/pdf', content_id: null, content_disposition: 'attachment' },
      ],
    } as never)
    vi.mocked(fetchInboundAttachment).mockResolvedValue({
      id: 'att_1',
      filename: 'faktura.pdf',
      contentType: 'application/pdf',
      buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer as ArrayBuffer,
    })

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.processed).toBe(1)
    expect(body.data.results).toEqual([{ attachment_id: 'att_1', inbox_item_id: 'item-pdf-1' }])
    expect(fetchInboundAttachment).toHaveBeenCalledTimes(1)
    expect(fetchInboundAttachment).toHaveBeenCalledWith('em_123', 'att_1')
    expect(receivedEvents()[0].payload).toMatchObject({
      outcome: 'attachments',
      attachments: [
        { id: 'att_logo', outcome: 'ignored', reason: 'signature_image' },
        { id: 'att_1', outcome: 'filed', inbox_item_id: 'item-pdf-1' },
      ],
    })
  })

  it('applies the same rule inside a Gmail "forward as attachment" (.eml) whose body is the receipt', async () => {
    // The forwarded mail arrives as one message/rfc822 attachment; inside it
    // the receipt is the HTML body and the only part is the sender's logo.
    vi.mocked(verifyInboundWebhook).mockReturnValue(
      mockReceivedEvent({
        subject: 'Fwd: Ditt kvitto',
        attachments: [
          { id: 'att_eml', filename: 'Ditt kvitto.eml', size: 4_000, content_type: 'message/rfc822', content_id: null, content_disposition: 'attachment' },
        ],
      }) as never,
    )
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // per-attachment dup check for the .eml
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-inner-body' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'anna@example.se',
      created_at: '2026-09-18T12:03:00Z',
      subject: 'Fwd: Ditt kvitto',
      bcc: null,
      cc: null,
      reply_to: null,
      html: null,
      text: '',
      headers: {},
      message_id: '<msg-id@supplier.com>',
      raw: null,
      attachments: [
        { id: 'att_eml', filename: 'Ditt kvitto.eml', size: 4_000, content_type: 'message/rfc822', content_id: null, content_disposition: 'attachment' },
      ],
    } as never)
    const receiptHtml =
      '<div>Spotify Premium 119,00 kr<br>Moms 25% 23,80 kr<br>Totalt 119,00 kr<br>' +
      'Ordernummer 4711-2026<br>Betalt med kort som slutar på 1234<br>' +
      'Spotify AB, Regeringsgatan 19, 111 53 Stockholm, org.nr 556703-7485</div>' +
      '<img src="cid:logo@spotify">'
    const eml = [
      'From: Spotify <no-reply@spotify.com>',
      'To: anna@example.se',
      'Subject: Ditt kvitto',
      'Date: Thu, 18 Sep 2026 14:03:00 +0200',
      'Message-ID: <inner-1@spotify.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="B1"',
      '',
      '--B1',
      'Content-Type: text/html; charset=utf-8',
      '',
      receiptHtml,
      '--B1',
      'Content-Type: image/png; name="logo.png"',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo@spotify>',
      'Content-Disposition: inline; filename="logo.png"',
      '',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64'),
      '--B1--',
      '',
    ].join('\r\n')
    vi.mocked(fetchInboundAttachment).mockResolvedValue({
      id: 'att_eml',
      filename: 'Ditt kvitto.eml',
      contentType: 'message/rfc822',
      buffer: new Uint8Array(Buffer.from(eml, 'utf8')).buffer as ArrayBuffer,
    })

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.results).toEqual([{ attachment_id: 'att_eml', inbox_item_id: 'item-inner-body' }])
    expect(calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'insert')).toBeUndefined()

    const [, , , file, , emailMeta] = vi.mocked(uploadAndExtract).mock.calls[0]
    expect(file.type).toBe('application/pdf')
    // Named and attributed after the forwarded mail, not the forward.
    expect(file.name).toBe('mail-Ditt_kvitto.pdf')
    // mailparser quotes the display name.
    expect(emailMeta?.from).toBe('"Spotify" <no-reply@spotify.com>')
    expect(emailMeta?.subject).toBe('Ditt kvitto')
    expect(emailMeta?.resendAttachmentId).toBe('att_eml')
    expect(receivedEvents()[0].payload).toMatchObject({
      outcome: 'attachments',
      attachments: [
        { id: 'att_eml#0', outcome: 'ignored', reason: 'signature_image', mime: 'image/png' },
        { id: 'att_eml', outcome: 'filed', inbox_item_id: 'item-inner-body' },
      ],
    })
  })

  it('still files an inline image that is large enough to be a receipt photo', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // per-attachment dup check
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-photo-1' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue({
      object: 'email',
      id: 'em_123',
      to: ['acme-ab-x7f2@arcim.io'],
      from: 'anna@example.se',
      created_at: '2026-04-20T10:00:00Z',
      subject: 'Kvitto lunch',
      bcc: null,
      cc: null,
      reply_to: null,
      html: '<div>Skickat från min iPhone</div><img src="cid:photo@x">',
      text: 'Skickat från min iPhone',
      headers: {},
      message_id: '<msg@x>',
      raw: null,
      attachments: [
        { id: 'att_photo', filename: 'IMG_0042.jpeg', size: 2_400_000, content_type: 'image/jpeg', content_id: 'photo@x', content_disposition: 'inline' },
      ],
    } as never)
    vi.mocked(fetchInboundAttachment).mockResolvedValue({
      id: 'att_photo',
      filename: 'IMG_0042.jpeg',
      contentType: 'image/jpeg',
      buffer: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer as ArrayBuffer,
    })

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.results).toEqual([{ attachment_id: 'att_photo', inbox_item_id: 'item-photo-1' }])
    expect(fetchInboundAttachment).toHaveBeenCalledWith('em_123', 'att_photo')
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
      inbox_id: 'inbox-1',
      custom_domain: false,
      tags: ['lev', 'ver'],
      unknown_tag_count: 0,
      kind_hint: null,
      tag_conflict: true,
      outcome: 'attachments',
      attachment_count: 1,
      attachments: [{ id: 'att_1', outcome: 'filed', inbox_item_id: 'item-1' }],
    })
    expect(JSON.stringify(events[0].payload)).not.toContain('billing@supplier.com')
    expect(JSON.stringify(events[0].payload)).not.toContain('Faktura')
    // No address at all: an enskild firma's local part is the owner's name.
    expect(JSON.stringify(events[0].payload)).not.toContain('@')
    expect(JSON.stringify(events[0].payload)).not.toContain('acme-ab-x7f2')
  })

  it('counts a sender-typed tag without storing it, so a numeric tag cannot trip the PII validator', async () => {
    const to = ['acme-ab-x7f2+8501011234@arcim.io', 'acme-ab-x7f2+lev@arcim.io']
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent({ to, attachments: [] }) as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: null }) // body-document dedupe check
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-body' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(to, [], { html: '<p>Kvitto</p>' }) as never)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    expect(res.status).toBe(200)
    const [event] = receivedEvents()
    expect(event.payload).toMatchObject({ tags: ['lev'], unknown_tag_count: 1, kind_hint: 'supplier_invoice', tag_conflict: false })
    expect(JSON.stringify(event.payload)).not.toContain('8501011234')
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
    expect(events[0].payload).toMatchObject({ inbox_id: 'inbox-1', tags: ['lev'], kind_hint: 'supplier_invoice', tag_conflict: false })
    expect(events[1].payload).toMatchObject({ inbox_id: 'inbox-2', tags: [], kind_hint: null, custom_domain: false })
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

  it('lets a Resend redelivery replace a transient error row and file the attachment (self-heal kept)', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    // The first delivery's download failed and the catch wrote this row.
    enqueue({ data: { id: 'err-1', status: 'error', raw_email_payload: { messageId: 'm', transient: true } } })
    enqueue({ data: null }) // delete of the transient row
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-healed' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(['acme-ab-x7f2@arcim.io'], [PDF_ATTACHMENT]) as never)
    vi.mocked(fetchInboundAttachment).mockResolvedValue(PDF_DOWNLOAD)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.results).toEqual([{ attachment_id: 'att_1', inbox_item_id: 'item-healed' }])
    const del = calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'delete')
    expect(del).toBeDefined()
    const delEq = calls.filter((c) => c.table === 'invoice_inbox_items' && c.method === 'eq').find((c) => c.args[0] === 'id')
    expect(delEq?.args).toEqual(['id', 'err-1'])
    // The replacement leaves a trace: the record names the row it replaced.
    expect(receivedEvents()[0].payload).toMatchObject({
      attachments: [{ id: 'att_1', outcome: 'filed', inbox_item_id: 'item-healed', replaced_item_id: 'err-1' }],
    })
  })

  it('processes five inboxes per mail and records the rest as not processed', async () => {
    // Two unknown local parts first: they must not use up the cap.
    const to = [
      'unknown-a-0000@arcim.io',
      'unknown-b-0000@arcim.io',
      ...Array.from({ length: 7 }, (_, i) => `inbox-${i}-abcd@arcim.io`),
    ]
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent({ to, attachments: [] }) as never)
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: null }) // unknown-a
    enqueue({ data: null }) // unknown-b
    for (let i = 0; i < 7; i++) {
      enqueue({ data: { id: `inbox-${i}`, company_id: `company-${i}`, status: 'active' } })
    }
    for (let i = 0; i < 5; i++) enqueue({ data: { created_by: `owner-${i}` } })
    for (let i = 0; i < 5; i++) enqueue({ data: null }) // body-document dedupe checks
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(uploadAndExtract).mockResolvedValue({ inbox_item_id: 'item-body' } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(to, [], { html: '<p>Kvitto</p>' }) as never)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    // Every addressed inbox is looked up; the first five resolved are processed.
    expect(calls.filter((c) => c.table === 'company_inboxes' && c.method === 'eq')).toHaveLength(9)
    expect(body.data.targets.map((t: { company_id: string }) => t.company_id)).toEqual(
      ['company-0', 'company-1', 'company-2', 'company-3', 'company-4'],
    )
    expect(body.data.deferred).toEqual([
      { company_id: 'company-5', reason: 'fan_out_capped' },
      { company_id: 'company-6', reason: 'fan_out_capped' },
    ])
    expect(uploadAndExtract).toHaveBeenCalledTimes(5)
    // The two past the cap still get a record: arrived, not processed.
    const events = receivedEvents()
    expect(events).toHaveLength(7)
    expect(events.slice(5).map((e) => [e.companyId, e.payload.outcome])).toEqual([
      ['company-5', 'fan_out_capped'],
      ['company-6', 'fan_out_capped'],
    ])
  })

  it('keeps a rejected attachment (bad type) as a duplicate on redelivery', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue(mockReceivedEvent() as never)
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'inbox-1', company_id: 'company-1', status: 'active' } })
    enqueue({ data: { created_by: 'user-owner-1' } })
    enqueue({ data: { id: 'rej-1', status: 'error', raw_email_payload: { messageId: 'm', mime: 'application/zip' } } })
    vi.mocked(createClient).mockReturnValue(supabase as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(fullEmailFor(['acme-ab-x7f2@arcim.io'], [PDF_ATTACHMENT]) as never)

    const res = await webhookRoute.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(body.data.results[0]).toEqual({ attachment_id: 'att_1', inbox_item_id: 'rej-1', duplicate: true })
    expect(fetchInboundAttachment).not.toHaveBeenCalled()
    expect(calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'delete')).toBeUndefined()
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
      raw_email_payload: { transient: true },
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
