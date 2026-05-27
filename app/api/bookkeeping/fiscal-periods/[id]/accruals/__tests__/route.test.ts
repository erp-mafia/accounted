import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const mockCreateClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockBuildAccrualsProposal = vi.fn()
const mockDetectPeriodisering = vi.fn()
vi.mock('@/lib/bokslut/accruals/accrual-detector', async () => {
  const actual =
    (await vi.importActual('@/lib/bokslut/accruals/accrual-detector')) as Record<string, unknown>
  return {
    ...actual,
    buildAccrualsProposal: (...args: unknown[]) => mockBuildAccrualsProposal(...args),
  }
})

vi.mock('@/lib/bokslut/accruals/auto-detect', () => ({
  detectPeriodisering: (...args: unknown[]) => mockDetectPeriodisering(...args),
}))

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateClient.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }) },
  })
})

describe('GET /api/bookkeeping/fiscal-periods/[id]/accruals', () => {
  it('returns 401 when unauthenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    })
    const { GET } = await import('../route')
    const res = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/accruals'),
      createMockRouteParams({ id: 'period-1' }),
    )
    expect(res.status).toBe(401)
  })

  it('returns the snapshot plus autoDetected suggestions', async () => {
    mockBuildAccrualsProposal.mockResolvedValue({
      fiscalPeriod: { id: 'period-1', name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
      proposals: [],
    })
    mockDetectPeriodisering.mockResolvedValue([
      {
        source_invoice_id: 'sup-1',
        source_type: 'supplier_invoice',
        original_amount: 12000,
        periodisering_amount: 6000,
        parsed_start: '2025-07-01',
        parsed_end: '2026-06-30',
        confidence: 'high',
        reason: 'Mock reason',
        source_label: 'Test Supplier',
        suggested_prepaid_account: '1710',
        suggested_deferred_account: null,
      },
    ])
    const { GET } = await import('../route')
    const res = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/accruals'),
      createMockRouteParams({ id: 'period-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { autoDetected: unknown[] } }>(res)
    expect(status).toBe(200)
    expect(body.data.autoDetected).toHaveLength(1)
  })

  it('still returns the snapshot when auto-detect throws', async () => {
    mockBuildAccrualsProposal.mockResolvedValue({
      fiscalPeriod: { id: 'period-1', name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
      proposals: [],
    })
    mockDetectPeriodisering.mockRejectedValue(new Error('boom'))
    const { GET } = await import('../route')
    const res = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/accruals'),
      createMockRouteParams({ id: 'period-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { autoDetected: unknown[] } }>(res)
    expect(status).toBe(200)
    expect(body.data.autoDetected).toEqual([])
  })
})
