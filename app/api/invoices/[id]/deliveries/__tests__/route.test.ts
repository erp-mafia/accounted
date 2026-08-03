import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET } from '../route'

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000'

describe('GET /api/invoices/[id]/deliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'user@example.com' } },
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const response = await GET(
      createMockRequest('/api/invoices/invoice-1/deliveries'),
      createMockRouteParams({ id: 'invoice-1' }),
    )

    expect(response.status).toBe(401)
  })

  it('returns 400 when the invoice id is invalid', async () => {
    const response = await GET(
      createMockRequest('/api/invoices/not-a-uuid/deliveries'),
      createMockRouteParams({ id: 'not-a-uuid' }),
    )

    expect(response.status).toBe(400)
  })

  it('returns 404 when the invoice is outside the active company', async () => {
    enqueue({ data: null, error: null })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/deliveries`),
      createMockRouteParams({ id: INVOICE_ID }),
    )

    expect(response.status).toBe(404)
  })

  it('returns minimized delivery evidence for the active company', async () => {
    const delivery = {
      id: 'delivery-1',
      channel: 'email',
      status: 'sent',
      to_addresses: ['customer@example.com'],
      cc_addresses: ['accounts@example.com'],
      bcc_addresses: ['archive@example.com'],
      reply_to: 'sender@example.com',
      from_name: 'Example AB',
      subject: 'Faktura F-1001',
      body_text: 'Hej! Här kommer fakturan.',
      provider: 'resend',
      provider_message_id: 'provider-1',
      provider_status: 'delivered',
      provider_status_at: '2026-07-22T10:30:04.000Z',
      provider_status_detail: null,
      provider_recipient_statuses: {
        'to:1': { status: 'delivered', status_at: '2026-07-22T10:30:04.000Z' },
        'cc:1': { status: 'delivered', status_at: '2026-07-22T10:30:04.000Z' },
        'bcc:1': { status: 'bounced', status_at: '2026-07-22T10:30:04.000Z' },
        'customer@example.com': {
          status: 'bounced',
          status_at: '2026-07-22T10:30:04.000Z',
        },
      },
      error_code: null,
      document_attachment_id: 'document-1',
      attachment_filename: 'faktura-f-1001.pdf',
      attachment_content_type: 'application/pdf',
      attachment_sha256: 'abc123',
      sent_at: '2026-07-22T10:30:00.000Z',
      failed_at: null,
      created_at: '2026-07-22T10:29:59.000Z',
    }
    enqueue({ data: { id: INVOICE_ID }, error: null })
    enqueue({ data: [delivery], error: null })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/deliveries`),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const { body } = await parseJsonResponse<{ data: Array<Record<string, unknown>> }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toEqual([{
      id: 'delivery-1',
      channel: 'email',
      status: 'sent',
      to_addresses: ['***@example.com'],
      cc_addresses: ['***@example.com'],
      provider: 'resend',
      provider_status: 'delivered',
      provider_status_at: '2026-07-22T10:30:04.000Z',
      provider_status_detail: null,
      provider_recipient_statuses: {
        'to:1': { status: 'delivered', status_at: '2026-07-22T10:30:04.000Z' },
        'cc:1': { status: 'delivered', status_at: '2026-07-22T10:30:04.000Z' },
      },
      error_code: null,
      document_attachment_id: 'document-1',
      attachment_filename: 'faktura-f-1001.pdf',
      sent_at: '2026-07-22T10:30:00.000Z',
      failed_at: null,
      created_at: '2026-07-22T10:29:59.000Z',
    }])
    expect(body.data[0]).not.toHaveProperty('bcc_addresses')
    expect(body.data[0]).not.toHaveProperty('reply_to')
    expect(body.data[0]).not.toHaveProperty('from_name')
    expect(body.data[0]).not.toHaveProperty('subject')
    expect(body.data[0]).not.toHaveProperty('body_text')
    expect(body.data[0]).not.toHaveProperty('body_html')
    expect(body.data[0]).not.toHaveProperty('provider_message_id')
    expect(JSON.stringify(body.data[0])).not.toContain('customer@example.com')
    expect(JSON.stringify(body.data[0])).not.toContain('bcc:1')
    expect(body.data[0]).not.toHaveProperty('attachment_content_type')
    expect(body.data[0]).not.toHaveProperty('attachment_sha256')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockSupabase.rpc).toHaveBeenCalledWith('list_invoice_delivery_summaries', {
      p_company_id: 'company-1',
      p_invoice_id: INVOICE_ID,
    })
  })

  it('masks recipient addresses quoted inside the provider reason text', async () => {
    enqueue({ data: { id: INVOICE_ID }, error: null })
    enqueue({
      data: [{
        id: 'delivery-2',
        channel: 'email',
        status: 'sent',
        to_addresses: ['customer@example.com'],
        cc_addresses: [],
        provider: 'resend',
        provider_status: 'bounced',
        provider_status_at: '2026-07-22T10:31:00.000Z',
        provider_status_detail:
          '550 5.1.1 <customer@example.com>: Recipient address rejected Permanent/General',
        error_code: null,
        document_attachment_id: 'document-1',
        attachment_filename: 'faktura-f-1001.pdf',
        sent_at: '2026-07-22T10:30:00.000Z',
        failed_at: null,
        created_at: '2026-07-22T10:29:59.000Z',
      }],
      error: null,
    })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/deliveries`),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const { body } = await parseJsonResponse<{ data: Array<Record<string, unknown>> }>(response)

    expect(body.data[0].provider_status).toBe('bounced')
    expect(body.data[0].provider_status_detail).toBe(
      '550 5.1.1 <***@example.com>: Recipient address rejected Permanent/General',
    )
  })

  // An ASCII allow-list stops at the first character it cannot spell and leaks
  // the head of the address ("anna.bergstr" out of anna.bergström@). Each of
  // these forms is a real local part a provider can quote back at us.
  it.each([
    ['non-ASCII local part', 'anna.bergström@example.se avvisad', '***@example.se avvisad'],
    ['quoted local part', '"anna berg"@example.com bounced', '***@example.com bounced'],
    ['apostrophe in local part', "o'brien@example.se hard bounce", '***@example.se hard bounce'],
    [
      'several addresses in one reason',
      'delivered to anna@example.se but not bob@example.com',
      'delivered to ***@example.se but not ***@example.com',
    ],
  ])('masks the %s in the provider reason text', async (_label, detail, expected) => {
    enqueue({ data: { id: INVOICE_ID }, error: null })
    enqueue({
      data: [{
        id: 'delivery-3',
        channel: 'email',
        status: 'sent',
        to_addresses: ['customer@example.com'],
        cc_addresses: [],
        provider: 'resend',
        provider_status: 'bounced',
        provider_status_at: '2026-07-22T10:31:00.000Z',
        provider_status_detail: detail,
        error_code: null,
        document_attachment_id: null,
        attachment_filename: null,
        sent_at: '2026-07-22T10:30:00.000Z',
        failed_at: null,
        created_at: '2026-07-22T10:29:59.000Z',
      }],
      error: null,
    })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/deliveries`),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const { body } = await parseJsonResponse<{ data: Array<Record<string, unknown>> }>(response)

    expect(body.data[0].provider_status_detail).toBe(expected)
    expect(body.data[0].provider_status_detail).not.toContain('anna')
  })
})
