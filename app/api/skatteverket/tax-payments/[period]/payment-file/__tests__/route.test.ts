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
  })
})
