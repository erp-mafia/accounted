import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { contentDispositionFilename } from '@/lib/api/content-disposition'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeCompanySettings,
  makeCustomer,
  makeInvoice,
} from '@/tests/helpers'
import type { InvoiceItem } from '@/types'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET, POST } from '../route'

const INVOICE_ID = '11111111-1111-4111-8111-111111111111'
const user = { id: 'user-1', email: 'owner@example.test' }
const customer = makeCustomer({
  name: 'Kund AB',
  org_number: '556677-8899',
  vat_number: 'SE556677889901',
})
const company = makeCompanySettings({
  company_name: 'Säljare AB',
  entity_type: 'aktiebolag',
  org_number: '556016-0680',
  vat_number: 'SE556016068001',
  bankgiro: '991-2346',
})
const item: InvoiceItem = {
  id: 'item-1',
  invoice_id: INVOICE_ID,
  sort_order: 0,
  line_type: 'product',
  description: 'Rådgivning',
  quantity: 1,
  unit: 'tim',
  unit_price: 100,
  line_total: 100,
  vat_rate: 25,
  vat_amount: 25,
}
const invoice = makeInvoice({
  id: INVOICE_ID,
  invoice_number: 'F-2026-42',
  invoice_date: '2026-08-13',
  due_date: '2026-09-12',
  status: 'sent',
  subtotal: 100,
  vat_amount: 25,
  total: 125,
  remaining_amount: 125,
  vat_treatment: 'standard_25',
  your_reference: 'KST-100',
  customer,
  items: [item],
})

describe('GET /api/invoices/[id]/peppol', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user, supabase: mockSupabase, error: null })
  })

  it('returns 401 when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol`),
      createMockRouteParams({ id: INVOICE_ID }),
    )

    expect(response.status).toBe(401)
  })

  it('returns 400 for an invalid invoice id', async () => {
    const response = await GET(
      createMockRequest('/api/invoices/not-a-uuid/peppol'),
      createMockRouteParams({ id: 'not-a-uuid' }),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns 404 when the invoice does not exist in the active company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol`),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('INVOICE_NOT_FOUND')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns a standards preflight error without producing partial XML', async () => {
    enqueue({ data: { ...invoice, your_reference: null }, error: null })
    enqueue({ data: company, error: null })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol`),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BUYER_REFERENCE_REQUIRED' }),
    ]))
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('downloads a valid Peppol BIS Billing XML document', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol`),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const xml = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(contentDispositionFilename(response.headers.get('Content-Disposition')))
      .toBe('peppol-invoice-F-2026-42.xml')
    expect(xml).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>')
    expect(xml).toContain('<cbc:PayableAmount currencyID="SEK">125.00</cbc:PayableAmount>')
  })
})

describe('POST /api/invoices/[id]/peppol', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    requireAuthMock.mockResolvedValue({ user, supabase: mockSupabase, error: null })
  })

  it('returns 401 when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol`, { method: 'POST' }),
      createMockRouteParams({ id: INVOICE_ID }),
    )

    expect(response.status).toBe(401)
  })

  it('returns 400 for an invalid invoice id', async () => {
    const response = await POST(
      createMockRequest('/api/invoices/not-a-uuid/peppol', { method: 'POST' }),
      createMockRouteParams({ id: 'not-a-uuid' }),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 when the invoice does not exist in the active company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await POST(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol`, { method: 'POST' }),
      createMockRouteParams({ id: INVOICE_ID }),
    )

    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('stages the exact XML but truthfully reports that nothing was sent', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })
    enqueue({
      data: {
        id: '22222222-2222-4222-8222-222222222222',
        invoice_id: INVOICE_ID,
        idempotency_key: '33333333-3333-4333-8333-333333333333',
        xml_sha256: 'a'.repeat(64),
        status: 'staged',
        filename: 'peppol-invoice-F-2026-42.xml',
        created_at: '2026-08-13T16:00:00.000Z',
      },
      error: null,
    })

    const response = await POST(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol`, { method: 'POST' }),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body.data).toMatchObject({
      status: 'staged',
      network_submitted: false,
      transport: {
        available: false,
        provider: null,
        reason: 'provider_selection_required',
      },
    })
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'stage_peppol_delivery',
      expect.objectContaining({
        p_company_id: 'company-1',
        p_invoice_id: INVOICE_ID,
        p_recipient_scheme: '0007',
        p_recipient_identifier: '5566778899',
        p_xml_payload: expect.stringContaining('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>'),
        p_xml_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    )
  })

  it.each([
    ['42501', 403, 'FORBIDDEN'],
    ['P0002', 404, 'NOT_FOUND'],
  ])('preserves staging SQLSTATE %s as an expected API response', async (
    code,
    expectedStatus,
    expectedCode,
  ) => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })
    enqueue({ data: null, error: { code, message: 'staging rejected' } })

    const response = await POST(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol`, { method: 'POST' }),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const body = await response.json()

    expect(response.status).toBe(expectedStatus)
    expect(body.error.code).toBe(expectedCode)
    expect(body.error.details).toMatchObject({ pgCode: code })
  })
})
