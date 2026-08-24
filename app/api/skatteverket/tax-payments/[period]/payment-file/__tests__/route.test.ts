import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const mockGenerateBgLb = vi.fn()
vi.mock('@/lib/salary/payment/bg-lb-generator', () => ({
  generateBankgiroPaymentBgLb: (...args: unknown[]) => mockGenerateBgLb(...args),
}))

const mockGeneratePain001 = vi.fn()
vi.mock('@/lib/payments/pain001-supplier', () => ({
  generateSupplierPain001: (...args: unknown[]) => mockGeneratePain001(...args),
}))

const mockResolveBatchDebtor = vi.fn()
vi.mock('@/lib/payments/batch-service', () => ({
  resolveBatchDebtor: (...args: unknown[]) => mockResolveBatchDebtor(...args),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted' }),
}))

vi.mock('@/lib/skatteverket/skattekonto-ocr', () => ({
  generateSkattekontoOcr: vi.fn().mockReturnValue('1234567890'),
  SKATTEKONTO_BANKGIRO: '5050-1055',
}))

vi.mock('@/lib/bankgiro/luhn', () => ({
  validateBankgiroNumber: vi.fn().mockReturnValue(true),
}))

import { GET } from '../route'

describe('GET /api/skatteverket/tax-payments/[period]/payment-file', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockGenerateBgLb.mockReturnValue({ content: 'LB-FILE', filename: 'skatt-2026-04.txt' })
    mockGeneratePain001.mockReturnValue('<Document/>')
    mockResolveBatchDebtor.mockResolvedValue({
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
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file'),
      createMockRouteParams({ period: '2026-04' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file'),
      createMockRouteParams({ period: '2026-04' }),
    )
    expect(response.status).toBe(403)
  })

  it('generates the LB file (happy path)', async () => {
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899' } }) // companies
    enqueue({ data: { bankgiro: '123-4567' } }) // company_settings
    enqueue({ data: null, error: null }) // update tax_payment_file_generated_at

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file'),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=iso-8859-1')
    expect(response.headers.get('Content-Disposition')).toContain('skatt-2026-04.txt')
    expect(mockGenerateBgLb).toHaveBeenCalledTimes(1)
    expect(mockGenerateBgLb.mock.calls[0][1]).toMatchObject({ amount: 1500 })
  })

  it('pays the declared whole-krona totals as-is for new-era declarations', async () => {
    // Declarations generated since the whole-krona change store the declared
    // integers (what Skatteverket computes from the underlag and draws), and
    // the matching salary booking credited 2731 with the same number: the
    // payment must be exactly their sum.
    enqueue({ data: { id: 'agi-1', total_tax: 12268, total_avgifter: 16073 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899' } }) // companies
    enqueue({ data: { bankgiro: '123-4567' } }) // company_settings
    enqueue({ data: null, error: null }) // update tax_payment_file_generated_at

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file'),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(200)
    expect(mockGenerateBgLb.mock.calls[0][1]).toMatchObject({ amount: 28341 })
  })

  it('keeps paying öre-exact for legacy öre-bearing declarations', async () => {
    // Legacy rows predate the whole-krona storage: their salary bookings
    // credited 2731 with the öre, so the payment keeps clearing 2731 in full
    // (the öre parks as a small skattekonto överskott, the pre-existing
    // equilibrium). Truncating here would strand the öre on 2731 instead.
    enqueue({ data: { id: 'agi-1', total_tax: 12268, total_avgifter: 16073.84 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899' } }) // companies
    enqueue({ data: { bankgiro: '123-4567' } }) // company_settings
    enqueue({ data: null, error: null }) // update tax_payment_file_generated_at

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file'),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(200)
    expect(mockGenerateBgLb.mock.calls[0][1]).toMatchObject({ amount: 28341.84 })
  })

  it('generates a pain.001 file when format=pain001', async () => {
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899' } }) // companies
    enqueue({ data: null, error: null }) // update tax_payment_file_generated_at

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'pain001' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(response.headers.get('Content-Disposition')).toContain('pain001_skatt_2026-04.xml')
    expect(mockGenerateBgLb).not.toHaveBeenCalled()
    expect(mockGeneratePain001).toHaveBeenCalledTimes(1)
    const [debtor, payments] = mockGeneratePain001.mock.calls[0]
    expect(debtor).toMatchObject({ iban: 'SE3550000000054910000003', bic: 'ESSESESS' })
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({
      payee: { type: 'bankgiro', bankgiro: '50501055' },
      payeeName: 'Skatteverket',
      amount: 1500,
      reference: { type: 'ocr', value: '1234567890' },
    })
  })

  it('returns 400 when the pain.001 debtor is missing an IBAN', async () => {
    mockResolveBatchDebtor.mockResolvedValue({ ok: false, missing: 'iban' })
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899' } }) // companies

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'pain001' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(JSON.stringify(body)).toContain('IBAN')
    expect(mockGeneratePain001).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown format', async () => {
    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'csv' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )
    expect(response.status).toBe(400)
    expect(mockGenerateBgLb).not.toHaveBeenCalled()
    expect(mockGeneratePain001).not.toHaveBeenCalled()
  })
})
