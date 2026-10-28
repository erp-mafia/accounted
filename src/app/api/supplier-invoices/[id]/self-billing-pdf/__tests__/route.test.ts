/**
 * GET /api/supplier-invoices/[id]/self-billing-pdf (crm#1367): the
 * självfaktura rendered from the stored row. The renderer is mocked: this is
 * about auth, the 404s and the file answer, not the PDF bytes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { mockRender } = vi.hoisted(() => ({ mockRender: vi.fn() }))
vi.mock('@/lib/supplier-invoices/self-billing/render', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supplier-invoices/self-billing/render')>(
    '@/lib/supplier-invoices/self-billing/render',
  )
  return { ...actual, renderSelfBillingPdfBuffer: mockRender }
})

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const SNAPSHOT = {
  v: 1,
  seller: { name: 'Exempel Energi AB', org_number: null, vat_number: 'SE559988776601', address_line1: 'Bruksvägen 2', address_line2: null, postal_code: '662 30', city: 'Åmål', country: 'SE' },
  buyer: { name: 'Exempelbolaget AB', org_number: '5566778899', vat_number: null, address_line1: 'Storgatan 1', address_line2: null, postal_code: '111 22', city: 'Stockholm', country: 'SE' },
  pay_to: { bankgiro: '5050-1055', plusgiro: null, iban: null, bic: null, clearing_number: null, account_number: null },
  agreement_ref: 'Flexavtal 2026',
  acceptance_text: 'Godkänd enligt avtalet.',
  credits: null,
}

const ROW = {
  id: 'si-1',
  supplier_invoice_number: 'SF-007',
  invoice_date: '2026-09-30',
  due_date: '2026-10-30',
  delivery_date: null,
  currency: 'SEK',
  subtotal: 1000,
  vat_amount: 250,
  total: 1250,
  is_credit_note: false,
  is_self_billed: true,
  self_billing_snapshot: SNAPSHOT,
  items: [{ sort_order: 0, description: 'Flex', quantity: 1, unit: 'st', unit_price: 1000, line_total: 1000, vat_rate: 0.25, vat_amount: 250 }],
}

function auth(tables: Record<string, unknown>) {
  const { supabase } = createTableMockSupabase(tables as never)
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

const get = (query = '') =>
  GET(createMockRequest(`/api/supplier-invoices/si-1/self-billing-pdf${query}`), createMockRouteParams({ id: 'si-1' }))

beforeEach(() => {
  vi.clearAllMocks()
  mockRender.mockResolvedValue(Buffer.from('%PDF-1.3 self-billing'))
})

describe('GET /api/supplier-invoices/[id]/self-billing-pdf', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await get()).status).toBe(401)
  })

  it('returns 404 for an invoice outside the company', async () => {
    auth({ supplier_invoices: { data: null } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await get())
    expect(status).toBe(404)
    expect(body.error.code).toBe('SI_NOT_FOUND')
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('returns 404 for an ordinary supplier invoice: its document is the supplier\'s', async () => {
    auth({ supplier_invoices: { data: { ...ROW, is_self_billed: false, self_billing_snapshot: null } } })
    expect((await get()).status).toBe(404)
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('renders the stored row and its frozen parties, inline on request', async () => {
    auth({ supplier_invoices: { data: ROW }, company_settings: { data: { invoice_primary_color: '#003366' } } })
    const res = await get('?disposition=inline')

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline;/)
    expect(res.headers.get('Content-Disposition')).toContain('SF-007')
    expect(mockRender).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.objectContaining({ supplier_invoice_number: 'SF-007', total: 1250, is_credit_note: false }),
        snapshot: SNAPSHOT,
        branding: expect.objectContaining({ primaryColor: '#003366' }),
      }),
    )
  })
})
