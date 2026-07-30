import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/reports/statement-reconciliation', () => ({
  reconcileStatements: vi.fn(),
}))

import { reconcileStatements } from '@/lib/reports/statement-reconciliation'
import { GET } from '../route'

const mockReconcile = vi.mocked(reconcileStatements)

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

// Next.js 16 static-route second arg
const ctx = { params: Promise.resolve({}) }

const RECONCILED = {
  fiscalYear: {
    id: 'period-1',
    name: 'Räkenskapsår 2025',
    start: '2025-01-01',
    end: '2025-12-31',
    isClosed: true,
  },
  figures: [
    { surface: 'Bokfört resultat (konto 2099)', family: 'ledger' as const, aretsResultat: 442_000 },
    { surface: 'INK2R (3.26/3.27)', family: 'statutory' as const, aretsResultat: 442_000 },
  ],
  disagreements: [],
  isReconciled: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  authed()
})

describe('GET /api/reports/statement-reconciliation', () => {
  it('401s when unauthenticated', async () => {
    unauthed()

    const res = await GET(
      createMockRequest('/api/reports/statement-reconciliation', {
        searchParams: { period_id: 'period-1' },
      }),
      ctx,
    )

    expect(res.status).toBe(401)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('400s without period_id', async () => {
    const res = await GET(
      createMockRequest('/api/reports/statement-reconciliation'),
      ctx,
    )

    expect(res.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: string }>(res)
    expect(body.error).toContain('period_id')
  })

  it('404s when the fiscal period does not exist', async () => {
    mockReconcile.mockRejectedValue(new Error('Fiscal period not found'))

    const res = await GET(
      createMockRequest('/api/reports/statement-reconciliation', {
        searchParams: { period_id: 'missing' },
      }),
      ctx,
    )

    expect(res.status).toBe(404)
  })

  it('returns the figures and the reconciled flag', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReconcile.mockResolvedValue(RECONCILED as any)

    const res = await GET(
      createMockRequest('/api/reports/statement-reconciliation', {
        searchParams: { period_id: 'period-1' },
      }),
      ctx,
    )

    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<typeof RECONCILED>(res)
    expect(body.isReconciled).toBe(true)
    expect(body.figures).toHaveLength(2)
    expect(mockReconcile).toHaveBeenCalledWith(expect.anything(), 'company-1', 'period-1')
  })

  it('surfaces a disagreement rather than hiding it behind a 200 with no signal', async () => {
    mockReconcile.mockResolvedValue({
      ...RECONCILED,
      disagreements: ['INK2R (3.26/3.27) visar 0 kr medan bokföringen visar 442000 kr på konto 2099.'],
      isReconciled: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const res = await GET(
      createMockRequest('/api/reports/statement-reconciliation', {
        searchParams: { period_id: 'period-1' },
      }),
      ctx,
    )

    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<typeof RECONCILED>(res)
    expect(body.isReconciled).toBe(false)
    expect(body.disagreements[0]).toContain('konto 2099')
  })
})
