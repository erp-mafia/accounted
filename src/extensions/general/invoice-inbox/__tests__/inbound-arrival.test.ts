import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockRequest, createTableMockSupabase, testRoutes, type TableMockResolver } from '@/tests/helpers'

vi.mock('@/extensions/general/invoice-inbox/lib/resend-inbound', async () => {
  const actual = await vi.importActual<typeof import('@/extensions/general/invoice-inbox/lib/resend-inbound')>(
    '@/extensions/general/invoice-inbox/lib/resend-inbound'
  )
  return { ...actual, verifyInboundWebhook: vi.fn(), fetchReceivingEmail: vi.fn(), fetchInboundAttachment: vi.fn() }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))
vi.mock('@/extensions/general/invoice-inbox/lib/upload-and-extract', async () => {
  const actual = await vi.importActual<typeof import('@/extensions/general/invoice-inbox/lib/upload-and-extract')>(
    '@/extensions/general/invoice-inbox/lib/upload-and-extract'
  )
  return { ...actual, uploadAndExtract: vi.fn() }
})
vi.mock('@/lib/rate-limits/inbox', () => ({ checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn().mockResolvedValue('event-id') }))

import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  recordInboundMailArrivals,
  trimEmailHeaders,
  type InboundMailTargetOutcome,
} from '@/extensions/general/invoice-inbox/lib/inbound-arrival'
import {
  fetchInboundAttachment,
  fetchReceivingEmail,
  verifyInboundWebhook,
  type ResendReceivedEmail,
} from '@/extensions/general/invoice-inbox/lib/resend-inbound'
import { uploadAndExtract } from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import { createClient } from '@supabase/supabase-js'

const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ITEM_BODY = '10000000-0000-4000-8000-000000000001'
const ITEM_ATT = '10000000-0000-4000-8000-000000000002'
const ITEM_REJECTED = '10000000-0000-4000-8000-000000000003'
const DOC_BODY = '20000000-0000-4000-8000-000000000001'
const DOC_ATT = '20000000-0000-4000-8000-000000000002'
const RAW = 'From: billing@supplier.example\r\nSubject: Invoice\r\n\r\nSee attached.'

function receivedEmail(overrides: Partial<ResendReceivedEmail> = {}): ResendReceivedEmail {
  return {
    object: 'email',
    id: 'em_123',
    to: ['acme-ab-x7f2@arcim.io'],
    from: 'billing@supplier.example',
    created_at: '2026-10-15T09:00:00Z',
    subject: 'Invoice #5678',
    bcc: null,
    cc: ['bokforing@acme.example'],
    reply_to: ['ar@supplier.example'],
    received_for: ['acme-ab-x7f2@arcim.io'],
    html: '<p>See attached.</p>',
    text: 'See attached.',
    headers: {
      'Message-ID': '<msg@supplier.example>',
      'DKIM-Signature': 'v=1; a=rsa-sha256; b=' + 'x'.repeat(500),
      Date: 'Wed, 15 Oct 2026 09:00:00 +0000',
    },
    message_id: '<msg@supplier.example>',
    raw: { download_url: RAW_URL, expires_at: '2026-10-15T10:00:00Z' },
    attachments: [{ id: 'att_1', filename: 'invoice.pdf', size: 1234, content_type: 'application/pdf', content_id: null, content_disposition: 'attachment' }],
    ...overrides,
  }
}

const EVENT = {
  email_id: 'em_123',
  from: 'billing@supplier.example',
  to: ['acme-ab-x7f2@arcim.io'],
  subject: 'Invoice #5678',
  message_id: '<msg@supplier.example>',
  created_at: '2026-10-15T09:00:00Z',
}

function target(overrides: Partial<InboundMailTargetOutcome> = {}): InboundMailTargetOutcome {
  return {
    companyId: COMPANY_A,
    inboxId: 'inbox-1',
    tags: ['lev'],
    attachments: [
      { id: 'att_1', outcome: 'filed', inbox_item_id: ITEM_ATT },
      { id: 'att_2', outcome: 'rejected', inbox_item_id: ITEM_REJECTED },
      { id: 'att_3', outcome: 'ignored' },
    ],
    ...overrides,
  }
}

/** Arrival lookups answer "not recorded yet" unless told otherwise; upserts echo the row. */
function arrivalsTable(existing: Record<string, unknown> | null = null): TableMockResolver {
  return (calls) => {
    const upsert = calls.find((c) => c.method === 'upsert')
    if (upsert) return { data: [{ ...(upsert.args[0] as Record<string, unknown>), created_at: '2026-10-15T09:00:01Z' }] }
    return { data: existing }
  }
}

const inboxItemsTable: TableMockResolver = (calls) => {
  if (calls.some((c) => c.method === 'in')) {
    return {
      data: [
        { id: ITEM_BODY, document_id: DOC_BODY },
        { id: ITEM_ATT, document_id: DOC_ATT },
        { id: ITEM_REJECTED, document_id: null },
      ],
    }
  }
  return { data: null }
}

function db(existingArrival: Record<string, unknown> | null = null) {
  const mock = createTableMockSupabase({
    arrivals: arrivalsTable(existingArrival),
    invoice_inbox_items: inboxItemsTable,
    arrival_outputs: { data: null },
  })
  const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
  const storage = { from: vi.fn(() => ({ upload })) }
  Object.assign(mock.supabase, { storage })
  return { ...mock, upload, client: mock.supabase as unknown as SupabaseClient }
}

const RAW_URL = 'https://inbound.resend.example/raw/em_123'
const realFetch = globalThis.fetch
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation(async () => new Response(RAW, { status: 200 }))
  // Only Resend's raw download is faked: the body renderer loads its wasm
  // through fetch too.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === RAW_URL ? fetchMock(input, init) : realFetch(input, init),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('recordInboundMailArrivals', () => {
  it('records the mail with its sender, text and trimmed headers, keeps the whole .eml, and links what it produced', async () => {
    const { client, payloads, upload } = db()
    await recordInboundMailArrivals(client, { email: receivedEmail(), event: EVENT, targets: [target()] })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toBe(RAW_URL)
    const [row] = payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(row).toMatchObject({
      company_id: COMPANY_A,
      source: 'intake_email',
      source_ref: 'em_123',
      received_at: '2026-10-15T09:00:00.000Z',
      sender: {
        from: 'billing@supplier.example',
        to: ['acme-ab-x7f2@arcim.io'],
        cc: ['bokforing@acme.example'],
        reply_to: ['ar@supplier.example'],
      },
      subject: 'Invoice #5678',
      message_text: 'See attached.',
      original_mime: 'message/rfc822',
      original_size: new TextEncoder().encode(RAW).byteLength,
      fetched_by: { type: 'webhook', label: 'resend-inbound' },
    })
    expect(row.original_path).toBe(`documents/${COMPANY_A}/arrivals/${row.id}/em_123.eml`)
    const meta = row.source_meta as Record<string, unknown>
    expect(meta.headers).toEqual({ 'message-id': '<msg@supplier.example>', date: 'Wed, 15 Oct 2026 09:00:00 +0000' })
    expect(meta).toMatchObject({ message_id: '<msg@supplier.example>', inbox_id: 'inbox-1', tags: ['lev'] })
    expect(upload).toHaveBeenCalledWith(row.original_path, expect.any(ArrayBuffer), { contentType: 'message/rfc822', upsert: false })

    const outputs = payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id, o.role])).toEqual([
      ['document', DOC_ATT, 'attachment'],
      ['inbox_item', ITEM_ATT, 'attachment'],
      ['inbox_item', ITEM_REJECTED, 'attachment'],
    ])
  })

  it('links the body underlag with role body', async () => {
    const { client, payloads } = db()
    await recordInboundMailArrivals(client, {
      email: receivedEmail({ attachments: [] }),
      event: EVENT,
      targets: [target({ reason: 'email_body', inbox_item_id: ITEM_BODY, attachments: [] })],
    })
    const outputs = payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id, o.role])).toEqual([
      ['document', DOC_BODY, 'body'],
      ['inbox_item', ITEM_BODY, 'body'],
    ])
  })

  it('downloads the mail once for two companies and stores a copy in each', async () => {
    const { client, payloads, upload } = db()
    await recordInboundMailArrivals(client, {
      email: receivedEmail(),
      event: EVENT,
      targets: [target(), target({ companyId: COMPANY_B, inboxId: 'inbox-2' })],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const rows = payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(rows.map((r) => r.company_id)).toEqual([COMPANY_A, COMPANY_B])
    expect(upload).toHaveBeenCalledTimes(2)
    expect(String(upload.mock.calls[1]![0])).toMatch(new RegExp(`^documents/${COMPANY_B}/arrivals/`))
  })

  it('on a redelivery neither downloads nor stores again, and the links stay idempotent', async () => {
    const { client, payloads, upload } = db({ id: '30000000-0000-4000-8000-000000000001', company_id: COMPANY_A })
    await recordInboundMailArrivals(client, { email: receivedEmail(), event: EVENT, targets: [target()] })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(payloads('arrivals', 'upsert')).toEqual([])
    expect(payloads('arrival_outputs', 'upsert')).toHaveLength(3)
  })

  it('skips a rate-limited drop: nothing entered', async () => {
    const { client, tables } = db()
    await recordInboundMailArrivals(client, {
      email: receivedEmail(),
      event: EVENT,
      targets: [target({ reason: 'rate_limited', attachments: [] })],
    })
    expect(tables()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records the arrival without its original when Resend offers none or the download fails', async () => {
    const noRaw = db()
    await recordInboundMailArrivals(noRaw.client, { email: receivedEmail({ raw: null }), event: EVENT, targets: [target()] })
    expect(fetchMock).not.toHaveBeenCalled()
    let [row] = noRaw.payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(row!.original_path).toBeNull()
    expect(row!.source_meta).toMatchObject({ original_missing: 'no_raw_from_provider' })

    fetchMock.mockImplementation(async () => new Response('gone', { status: 410 }))
    const failed = db()
    await expect(
      recordInboundMailArrivals(failed.client, { email: receivedEmail(), event: EVENT, targets: [target()] }),
    ).resolves.toBeUndefined()
    ;[row] = failed.payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(row!.original_path).toBeNull()
    expect(row!.source_meta).toMatchObject({ original_missing: 'fetch_failed' })
  })

  it('never throws when the database fails', async () => {
    const mock = createTableMockSupabase({ arrivals: { data: null, error: { message: 'relation "arrivals" does not exist' } } })
    await expect(
      recordInboundMailArrivals(mock.supabase as unknown as SupabaseClient, { email: receivedEmail(), event: EVENT, targets: [target()] }),
    ).resolves.toBeUndefined()
  })
})

describe('trimEmailHeaders', () => {
  it('drops transport signatures, lowercases names and caps values', () => {
    const trimmed = trimEmailHeaders({
      Subject: 's'.repeat(2_000),
      'ARC-Seal': 'x',
      'X-MS-Exchange-Organization-AuthAs': 'Anonymous',
      'In-Reply-To': '<a@b>',
    })
    expect(Object.keys(trimmed)).toEqual(['subject', 'in-reply-to'])
    expect(trimmed.subject).toHaveLength(1_000)
    expect(trimEmailHeaders(null)).toEqual({})
  })
})

describe('POST /inbound records the arrival', () => {
  const route = testRoutes(invoiceInboxExtension).find((r) => r.method === 'POST' && r.path === '/inbound')!
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.RESEND_INBOUND_DOMAIN = 'arcim.io'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('files the attachment as before and records the mail as an arrival linked to it', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue({
      type: 'email.received',
      created_at: EVENT.created_at,
      data: { ...EVENT, cc: [], bcc: [], attachments: [] },
    } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(receivedEmail())
    vi.mocked(fetchInboundAttachment).mockResolvedValue({
      id: 'att_1',
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      buffer: new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer,
    })
    vi.mocked(uploadAndExtract).mockResolvedValue({ document_id: DOC_ATT, inbox_item_id: ITEM_ATT } as never)

    const mock = createTableMockSupabase({
      company_inboxes: { data: { id: 'inbox-1', company_id: COMPANY_A, status: 'active' } },
      companies: { data: { created_by: 'owner-1' } },
      invoice_inbox_items: inboxItemsTable,
      arrivals: arrivalsTable(),
      arrival_outputs: { data: null },
    })
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    Object.assign(mock.supabase, { storage: { from: vi.fn(() => ({ upload })) } })
    vi.mocked(createClient).mockReturnValue(mock.supabase as never)

    const res = await route.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({ processed: 1, results: [{ attachment_id: 'att_1', inbox_item_id: ITEM_ATT }] })

    const [row] = mock.payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(row).toMatchObject({ company_id: COMPANY_A, source: 'intake_email', source_ref: 'em_123', original_mime: 'message/rfc822' })
    const outputs = mock.payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id])).toEqual([
      ['document', DOC_ATT],
      ['inbox_item', ITEM_ATT],
    ])
  })

  it('answers the same when recording the arrival fails', async () => {
    vi.mocked(verifyInboundWebhook).mockReturnValue({
      type: 'email.received',
      created_at: EVENT.created_at,
      data: { ...EVENT, cc: [], bcc: [], attachments: [] },
    } as never)
    vi.mocked(fetchReceivingEmail).mockResolvedValue(receivedEmail({ attachments: [] }))
    vi.mocked(uploadAndExtract).mockResolvedValue({ document_id: DOC_BODY, inbox_item_id: ITEM_BODY } as never)

    const mock = createTableMockSupabase({
      company_inboxes: { data: { id: 'inbox-1', company_id: COMPANY_A, status: 'active' } },
      companies: { data: { created_by: 'owner-1' } },
      invoice_inbox_items: { data: null },
      arrivals: { data: null, error: { message: 'permission denied for table arrivals' } },
    })
    vi.mocked(createClient).mockReturnValue(mock.supabase as never)

    const res = await route.handler(createMockRequest('/inbound', { method: 'POST', body: {} }))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ processed: 1, reason: 'email_body', inbox_item_id: ITEM_BODY })
  })
})
