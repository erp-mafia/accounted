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
vi.mock('@/lib/associations/member-register', () => ({
  requireMemberCapitalForm: vi.fn(),
  listContributions: vi.fn(),
  recordContribution: vi.fn(),
  settleContribution: vi.fn(),
  memberCapitalReconciliation: vi.fn(),
  memberRegisterExtract: vi.fn(),
  memberRegisterCsv: vi.fn(() => 'Medlemsnummer;Namn\n1;Anna\n'),
}))

import {
  memberCapitalReconciliation,
  memberRegisterExtract,
  recordContribution,
  requireMemberCapitalForm,
  settleContribution,
} from '@/lib/associations/member-register'
import { POST } from '../route'
import { POST as SETTLE } from '../[id]/settle/route'
import { GET as RECONCILIATION } from '../../reconciliation/route'
import { GET as REGISTER } from '../../register/route'

const routeParams = { params: Promise.resolve({}) }
const idParams = { params: Promise.resolve({ id: 'c1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  vi.mocked(requireMemberCapitalForm).mockResolvedValue(undefined)
})

describe('POST /api/associations/contributions', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(createMockRequest('/api/associations/contributions', { method: 'POST', body: {} }), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 for a negative amount or unknown kind', async () => {
    for (const body of [
      { member_id: '11111111-1111-4111-8111-111111111111', kind: 'obligatory', amount: -1, paid_on: '2026-01-10' },
      { member_id: '11111111-1111-4111-8111-111111111111', kind: 'shares', amount: 100, paid_on: '2026-01-10' },
    ]) {
      const res = await POST(createMockRequest('/api/associations/contributions', { method: 'POST', body }), routeParams)
      expect(res.status).toBe(400)
    }
    expect(recordContribution).not.toHaveBeenCalled()
  })

  it('records a contribution and answers 201', async () => {
    vi.mocked(recordContribution).mockResolvedValue({ id: 'c1', kind: 'obligatory', amount: 500 } as never)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(
      await POST(
        createMockRequest('/api/associations/contributions', {
          method: 'POST',
          body: { member_id: '11111111-1111-4111-8111-111111111111', kind: 'obligatory', amount: 500, paid_on: '2026-01-10' },
        }),
        routeParams,
      ),
    )
    expect(status).toBe(201)
    expect(body.data.id).toBe('c1')
  })
})

describe('POST /api/associations/contributions/[id]/settle', () => {
  it('maps a repayment before exit to 409 with the EFL reason', async () => {
    vi.mocked(settleContribution).mockRejectedValue(
      new AssociationRegisterError('ASSOCIATION_REPAYMENT_BEFORE_EXIT'),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await SETTLE(
        createMockRequest('/api/associations/contributions/c1/settle', {
          method: 'POST',
          body: { status: 'repaid', settled_on: '2026-08-01' },
        }),
        idParams,
      ),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ASSOCIATION_REPAYMENT_BEFORE_EXIT')
    expect(body.error.message).toContain('EFL 10 kap. 11 §')
  })

  it('settles and returns the row', async () => {
    vi.mocked(settleContribution).mockResolvedValue({ id: 'c1', status: 'forfeited' } as never)
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(
      await SETTLE(
        createMockRequest('/api/associations/contributions/c1/settle', {
          method: 'POST',
          body: { status: 'forfeited', settled_on: '2026-08-01' },
        }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.status).toBe('forfeited')
  })
})

describe('GET /api/associations/reconciliation', () => {
  it('returns 400 without a fiscal period and 404 for a period of another company', async () => {
    expect((await RECONCILIATION(createMockRequest('/api/associations/reconciliation'), routeParams)).status).toBe(400)
    enqueue({ data: null }) // fiscal_periods ownership check
    const res = await RECONCILIATION(
      createMockRequest('/api/associations/reconciliation?fiscal_period_id=11111111-1111-4111-8111-111111111111'),
      routeParams,
    )
    expect(res.status).toBe(404)
  })

  it('returns the reconciliation for an owned period', async () => {
    enqueue({ data: { id: '11111111-1111-4111-8111-111111111111' } })
    vi.mocked(memberCapitalReconciliation).mockResolvedValue({
      fiscal_period_id: '11111111-1111-4111-8111-111111111111',
      lines: [],
      is_reconciled: true,
    })
    const { status, body } = await parseJsonResponse<{ data: { is_reconciled: boolean } }>(
      await RECONCILIATION(
        createMockRequest('/api/associations/reconciliation?fiscal_period_id=11111111-1111-4111-8111-111111111111'),
        routeParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.is_reconciled).toBe(true)
  })
})

describe('GET /api/associations/register', () => {
  it('serves the medlemsförteckning as CSV with a BOM when asked', async () => {
    vi.mocked(memberRegisterExtract).mockResolvedValue([])
    const res = await REGISTER(createMockRequest('/api/associations/register?format=csv'), routeParams)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    // TextDecoder strips a leading BOM, so check the raw bytes.
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(bytes)).toBe('Medlemsnummer;Namn\n1;Anna\n')
  })
})
