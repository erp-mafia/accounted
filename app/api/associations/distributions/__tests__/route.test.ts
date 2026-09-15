import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { AssociationRegisterError } from '@/lib/associations/errors'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/associations/member-register', () => ({
  requireMemberCapitalForm: vi.fn(),
}))
vi.mock('@/lib/associations/distributions', () => ({
  listDistributions: vi.fn(),
  listAllocations: vi.fn(),
  createDistribution: vi.fn(),
  bookDistribution: vi.fn(),
  payDistribution: vi.fn(),
}))

import { requireMemberCapitalForm } from '@/lib/associations/member-register'
import {
  bookDistribution,
  createDistribution,
  listAllocations,
  listDistributions,
  payDistribution,
} from '@/lib/associations/distributions'
import { GET, POST } from '../route'
import { POST as BOOK } from '../[id]/book/route'
import { POST as PAY } from '../[id]/pay/route'

const routeParams = { params: Promise.resolve({}) }
const idParams = { params: Promise.resolve({ id: 'd1' }) }
const PERIOD = '11111111-1111-4111-8111-111111111111'
const MEMBER = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  vi.mocked(requireMemberCapitalForm).mockResolvedValue(undefined)
})

describe('GET /api/associations/distributions', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await GET(createMockRequest('/api/associations/distributions'), routeParams)).status).toBe(401)
  })

  it('maps another legal form to 409 ASSOCIATION_FORM_REQUIRED', async () => {
    vi.mocked(requireMemberCapitalForm).mockRejectedValue(new AssociationRegisterError('ASSOCIATION_FORM_REQUIRED'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/associations/distributions'), routeParams),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ASSOCIATION_FORM_REQUIRED')
  })

  it('lists the distributions with their allocations', async () => {
    vi.mocked(listDistributions).mockResolvedValue([{ id: 'd1', kind: 'insats_dividend' } as never])
    vi.mocked(listAllocations).mockResolvedValue([{ id: 'a1', member_id: MEMBER, amount: 100 } as never])
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string; allocations: unknown[] }> }>(
      await GET(createMockRequest(`/api/associations/distributions?fiscal_period_id=${PERIOD}`), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data[0].allocations).toHaveLength(1)
    expect(listDistributions).toHaveBeenCalledWith(expect.anything(), 'company-1', { fiscalPeriodId: PERIOD })
  })
})

describe('POST /api/associations/distributions', () => {
  const decision = {
    kind: 'insats_dividend',
    fiscal_period_id: PERIOD,
    decision_date: '2026-05-20',
    decided_by: 'stamma',
    decision_reference: 'Föreningsstämma 2026-05-20 § 9',
    allocation_basis: 'contributions',
    total_amount: 5000,
  }

  it('returns 400 for a non-positive total, an unknown kind, or a custom basis without allocations', async () => {
    for (const body of [
      { ...decision, total_amount: 0 },
      { ...decision, kind: 'bonus' },
      { ...decision, allocation_basis: 'custom' },
    ]) {
      const res = await POST(createMockRequest('/api/associations/distributions', { method: 'POST', body }), routeParams)
      expect(res.status).toBe(400)
    }
    expect(createDistribution).not.toHaveBeenCalled()
  })

  it('returns 404 for a period of another company', async () => {
    enqueue({ data: null }) // fiscal_periods ownership check
    const res = await POST(createMockRequest('/api/associations/distributions', { method: 'POST', body: decision }), routeParams)
    expect(res.status).toBe(404)
    expect(createDistribution).not.toHaveBeenCalled()
  })

  it('maps the beloppsspärr refusal to 409 with the EFL reason', async () => {
    enqueue({ data: { id: PERIOD } })
    vi.mocked(createDistribution).mockRejectedValue(
      new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_EXCEEDS_FREE_EQUITY'),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await POST(createMockRequest('/api/associations/distributions', { method: 'POST', body: decision }), routeParams),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ASSOCIATION_DISTRIBUTION_EXCEEDS_FREE_EQUITY')
    expect(body.error.message).toContain('EFL 12 kap. 2 §')
  })

  it('creates the decision with its allocations and answers 201', async () => {
    enqueue({ data: { id: PERIOD } })
    vi.mocked(createDistribution).mockResolvedValue({ id: 'd1', status: 'decided', allocations: [{ id: 'a1' }] } as never)
    const { status, body } = await parseJsonResponse<{ data: { id: string; allocations: unknown[] } }>(
      await POST(
        createMockRequest('/api/associations/distributions', {
          method: 'POST',
          body: { ...decision, allocation_basis: 'turnover', allocations: [{ member_id: MEMBER, basis_value: 120000 }] },
        }),
        routeParams,
      ),
    )
    expect(status).toBe(201)
    expect(body.data.allocations).toHaveLength(1)
    expect(createDistribution).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ allocation_basis: 'turnover', total_amount: 5000 }),
    )
  })
})

describe('POST /api/associations/distributions/[id]/book and /pay', () => {
  it('books the decision and returns the row', async () => {
    vi.mocked(bookDistribution).mockResolvedValue({ id: 'd1', status: 'booked', journal_entry_id: 'je1' } as never)
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(
      await BOOK(createMockRequest('/api/associations/distributions/d1/book', { method: 'POST', body: {} }), idParams),
    )
    expect(status).toBe(200)
    expect(body.data.status).toBe('booked')
  })

  it('maps a mismatch between allocations and total to 409', async () => {
    vi.mocked(bookDistribution).mockRejectedValue(
      new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_ALLOCATIONS_MISMATCH'),
    )
    const res = await BOOK(createMockRequest('/api/associations/distributions/d1/book', { method: 'POST', body: {} }), idParams)
    expect(res.status).toBe(409)
  })

  it('refuses a payment before the decision is booked and records one after', async () => {
    vi.mocked(payDistribution).mockRejectedValueOnce(new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_NOT_BOOKED'))
    const refused = await PAY(
      createMockRequest('/api/associations/distributions/d1/pay', { method: 'POST', body: { paid_on: '2026-06-01' } }),
      idParams,
    )
    expect(refused.status).toBe(409)
    vi.mocked(payDistribution).mockResolvedValue({ id: 'd1', status: 'paid' } as never)
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(
      await PAY(
        createMockRequest('/api/associations/distributions/d1/pay', {
          method: 'POST',
          body: { paid_on: '2026-06-01', bank_account: '1930' },
        }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.status).toBe('paid')
    expect(payDistribution).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'd1', {
      paid_on: '2026-06-01',
      bank_account: '1930',
    })
  })

  it('rejects a malformed bank account with 400', async () => {
    const res = await PAY(
      createMockRequest('/api/associations/distributions/d1/pay', { method: 'POST', body: { paid_on: '2026-06-01', bank_account: 'bank' } }),
      idParams,
    )
    expect(res.status).toBe(400)
    expect(payDistribution).not.toHaveBeenCalled()
  })
})
