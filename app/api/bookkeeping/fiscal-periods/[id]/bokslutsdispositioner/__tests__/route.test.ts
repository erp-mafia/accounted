/**
 * Tests for POST /api/bookkeeping/fiscal-periods/[id]/bokslutsdispositioner —
 * input-bound validation. The schablonintäkt rate feeds the avsättning cap
 * base (IL 30 kap 25 % limit), so an unbounded rate would let a caller
 * inflate the legal ceiling; these tests lock the bounds in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { POST } from '../route'

const idParams = { params: Promise.resolve({ id: 'period-1' }) }

function post(body: unknown) {
  return POST(
    createMockRequest('/api/bookkeeping/fiscal-periods/period-1/bokslutsdispositioner', {
      method: 'POST',
      body,
    }),
    idParams,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/bokslutsdispositioner', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await post({ items: [{ kind: 'bolagsskatt' }] })
    expect(res.status).toBe(401)
  })

  it('rejects an inflated schablonintäkt rate (cap-base attack) with 400', async () => {
    const { status } = await parseJsonResponse(
      await post({
        items: [{ kind: 'periodiseringsfond_avsattning', schablonintaktRate: 100 }],
      }),
    )
    expect(status).toBe(400)
  })

  it('rejects a negative desiredAmount with 400', async () => {
    const { status } = await parseJsonResponse(
      await post({
        items: [{ kind: 'periodiseringsfond_avsattning', desiredAmount: -50000 }],
      }),
    )
    expect(status).toBe(400)
  })

  it('rejects negative återföring amounts with 400', async () => {
    const { status } = await parseJsonResponse(
      await post({
        items: [{ kind: 'periodiseringsfond_ateforing', returns: { '2129': -10000 } }],
      }),
    )
    expect(status).toBe(400)
  })

  it('rejects an empty items array with 400', async () => {
    const { status } = await parseJsonResponse(await post({ items: [] }))
    expect(status).toBe(400)
  })
})
