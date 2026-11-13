import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

/**
 * "Bokför förfallna" is the daily cron's manual twin: both hand the company
 * to the same postDueInstallments, so a month is posted through the one
 * transaction (commit_accrual_installment) whichever of them runs, and a
 * click during the cron's run cannot book a month twice. The cron's side is
 * pinned in ../cron/__tests__/route.test.ts.
 */
const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const postDueInstallments = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  postDueInstallments: (...args: unknown[]) => postDueInstallments(...args),
}))

import { POST } from '../route'

const routeParams = { params: Promise.resolve({}) }
const request = () => createMockRequest('/api/bookkeeping/accruals/post-due', { method: 'POST' })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('POST /api/bookkeeping/accruals/post-due', () => {
  it('returns 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const { status } = await parseJsonResponse(await POST(request(), routeParams))

    expect(status).toBe(401)
    expect(postDueInstallments).not.toHaveBeenCalled()
  })

  it('posts the active company through the service the cron uses, as the signed-in user', async () => {
    const result = { posted: 2, failed: 0, skipped: 1, errors: [] }
    postDueInstallments.mockResolvedValue(result)

    const { status, body } = await parseJsonResponse<{ data: typeof result }>(await POST(request(), routeParams))

    expect(status).toBe(200)
    expect(body.data).toEqual(result)
    expect(postDueInstallments).toHaveBeenCalledTimes(1)
    expect(postDueInstallments).toHaveBeenCalledWith(supabase, 'company-1', { userId: 'user-1' })
  })
})
