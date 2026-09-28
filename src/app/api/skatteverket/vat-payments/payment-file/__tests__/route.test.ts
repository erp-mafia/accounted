import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()
const calculateVatDeclarationMock = vi.fn()
const generatePain001Mock = vi.fn()
const resolveBatchDebtorMock = vi.fn()
const resolveCombinedTaxPaymentMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/reports/vat-declaration', () => ({
  calculateVatDeclaration: (...args: unknown[]) => calculateVatDeclarationMock(...args),
}))
vi.mock('@/lib/payments/pain001-supplier', () => ({
  generateSupplierPain001: (...args: unknown[]) => generatePain001Mock(...args),
}))
vi.mock('@/lib/payments/batch-service', () => ({
  resolveBatchDebtor: (...args: unknown[]) => resolveBatchDebtorMock(...args),
}))
vi.mock('@/lib/skatteverket/skattekonto-ocr', () => ({
  resolveSkattekontoOcr: vi.fn().mockResolvedValue('1655954700217'),
  SKATTEKONTO_BANKGIRO: '5050-1055',
}))
vi.mock('@/lib/branding/service', () => ({ getBranding: () => ({ appName: 'Accounted' }) }))
vi.mock('@/lib/skatteverket/combined-tax-payment', () => ({
  vatTaxPaymentDate: vi.fn().mockReturnValue('2026-08-17'),
  resolveCombinedTaxPayment: (...args: unknown[]) => resolveCombinedTaxPaymentMock(...args),
}))

import { GET } from '../route'

const request = (query = '') =>
  createMockRequest(`/api/skatteverket/vat-payments/payment-file?periodType=quarterly&year=2026&period=2${query}`)

describe('GET /api/skatteverket/vat-payments/payment-file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: mockSupabase,
      error: null,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
    calculateVatDeclarationMock.mockResolvedValue({
      rutor: { ruta10: 12_500, ruta48: 2_500, ruta49: 10_000 },
    })
    generatePain001Mock.mockReturnValue('<Document/>')
    resolveBatchDebtorMock.mockResolvedValue({
      ok: true,
      debtor: {
        name: 'Test AB',
        org_number: '5566778899',
        iban: 'SE3550000000054910000003',
        bic: 'ESSESESS',
        bankgiro: '1234567',
        city: 'Stockholm',
      },
    })
    resolveCombinedTaxPaymentMock.mockResolvedValue({
      paymentDate: '2026-08-17',
      agi: null,
      vat: { periodType: 'quarterly', year: 2026, period: 2, amount: 10_000 },
      totalAmount: 10_000,
    })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await GET(request(), createMockRouteParams({}))).status).toBe(401)
  })

  it('rejects an invalid period before reading the declaration', async () => {
    const response = await GET(
      createMockRequest('/api/skatteverket/vat-payments/payment-file?periodType=quarterly&year=2026&period=5'),
      createMockRouteParams({}),
    )
    expect(response.status).toBe(400)
    expect(calculateVatDeclarationMock).not.toHaveBeenCalled()
  })

  it('does not create a payment for VAT to be refunded', async () => {
    resolveCombinedTaxPaymentMock.mockResolvedValue({
      paymentDate: '2026-08-17', agi: null, vat: null, totalAmount: 0,
    })
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } })
    enqueue({ data: { bankgiro: '123-4567' } })
    const response = await GET(request(), createMockRouteParams({}))
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('inget moms- eller AGI-belopp')
  })

  it('generates pain.001 from the filed whole-krona ruta 49 amount', async () => {
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } })
    enqueue({
      data: {
        bankgiro: '123-4567',
        fiscal_year_start_month: 1,
        vat_has_eu_trade: false,
        vat_filing_method: 'electronic',
        vat_taxable_base_over_40m: false,
      },
    })

    const response = await GET(request('&format=pain001'), createMockRouteParams({}))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(response.headers.get('Content-Disposition')).toContain('pain001_skatt_2026-08-17.xml')
    const [, payments] = generatePain001Mock.mock.calls[0]
    expect(payments[0]).toMatchObject({
      payee: { type: 'bankgiro', bankgiro: '50501055' },
      amount: 10_000,
      paymentDate: '2026-08-17',
      reference: { type: 'ocr', value: '1655954700217' },
    })
  })
})
