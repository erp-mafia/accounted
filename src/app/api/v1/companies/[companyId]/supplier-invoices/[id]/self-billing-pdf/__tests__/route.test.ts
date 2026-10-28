/**
 * GET /api/v1/companies/:companyId/supplier-invoices/:id/self-billing-pdf
 * (crm#1367). The renderer is mocked: routing, auth and error mapping only.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
const { mockRender } = vi.hoisted(() => ({ mockRender: vi.fn() }))
vi.mock('@/lib/supplier-invoices/self-billing/render', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supplier-invoices/self-billing/render')>(
    '@/lib/supplier-invoices/self-billing/render',
  )
  return { ...actual, renderSelfBillingPdfBuffer: mockRender }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET } from '../route'
import { createTableMockSupabase } from '@/tests/helpers'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const SNAPSHOT = {
  v: 1,
  seller: { name: 'Exempel Energi AB', org_number: null, vat_number: 'SE559988776601', address_line1: 'Bruksvägen 2', address_line2: null, postal_code: '662 30', city: 'Åmål', country: 'SE' },
  buyer: { name: 'Exempelbolaget AB', org_number: '5566778899', vat_number: null, address_line1: 'Storgatan 1', address_line2: null, postal_code: '111 22', city: 'Stockholm', country: 'SE' },
  pay_to: { bankgiro: null, plusgiro: null, iban: null, bic: null, clearing_number: null, account_number: null },
  agreement_ref: 'Flexavtal 2026',
  acceptance_text: 'Godkänd enligt avtalet.',
  credits: { number: 'SF-007', invoice_date: '2026-09-30' },
}

const ROW = {
  id: INVOICE_ID,
  supplier_invoice_number: 'SF-008',
  invoice_date: '2026-10-21',
  due_date: '2026-10-21',
  delivery_date: null,
  currency: 'SEK',
  subtotal: 1000,
  vat_amount: 250,
  total: 1250,
  is_credit_note: true,
  is_self_billed: true,
  self_billing_snapshot: SNAPSHOT,
  items: [],
}

const request = (id: string) =>
  new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${id}/self-billing-pdf`, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
const params = (id: string) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

function install(row: unknown) {
  mockServiceClient.mockReturnValue(
    createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      supplier_invoices: { data: row, error: null },
      company_settings: { data: null, error: null },
    }).supabase,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRender.mockResolvedValue(Buffer.from('%PDF-1.3 credit'))
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['suppliers:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/.../supplier-invoices/:id/self-billing-pdf', () => {
  it('returns 401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'invalid api key', status: 401 })
    expect((await GET(request(INVOICE_ID), params(INVOICE_ID))).status).toBe(401)
  })

  it('returns 400 for an id that is not a uuid', async () => {
    install(ROW)
    expect((await GET(request('nope'), params('nope'))).status).toBe(400)
  })

  it('returns 404 for an ordinary supplier invoice', async () => {
    install({ ...ROW, is_self_billed: false })
    const res = await GET(request(INVOICE_ID), params(INVOICE_ID))
    expect(res.status).toBe(404)
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('renders a self-billing credit note as a kreditfaktura', async () => {
    install(ROW)
    const res = await GET(request(INVOICE_ID), params(INVOICE_ID))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('Kreditfaktura')
    expect(mockRender).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: expect.objectContaining({ is_credit_note: true }), snapshot: SNAPSHOT }),
    )
  })
})
