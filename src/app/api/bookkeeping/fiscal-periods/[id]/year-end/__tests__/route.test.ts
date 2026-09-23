import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/core/bookkeeping/year-end-service', () => ({
  validateYearEndReadiness: vi.fn(),
  previewYearEndClosing: vi.fn(),
  executeYearEndClosing: vi.fn(),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { executeYearEndClosing } from '@/lib/core/bookkeeping/year-end-service'
import { POST } from '../route'

const params = createMockRouteParams({ id: 'period-1' })
const request = () => createMockRequest('/api/bookkeeping/fiscal-periods/period-1/year-end', {
  method: 'POST',
})

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1' },
    supabase: {},
    error: null,
  })
  requireWriteMock.mockResolvedValue({ ok: true })
  vi.mocked(executeYearEndClosing).mockResolvedValue({
    closingEntry: { id: 'closing-1' },
    nextPeriod: { id: 'period-2' },
  } as never)
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/year-end', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    expect((await POST(request(), params)).status).toBe(401)
  })

  it('returns a specific 409 for a period without posted result activity', async () => {
    vi.mocked(executeYearEndClosing).mockRejectedValue(
      new Error('No result accounts to close: period has no activity'),
    )

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(request(), params),
    )

    expect(status).toBe(409)
    expect(body.error.code).toBe('YEAR_END_NO_ACTIVITY')
  })

  it('returns 404 when the fiscal period is missing', async () => {
    vi.mocked(executeYearEndClosing).mockRejectedValue(new Error('Fiscal period not found'))

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(request(), params),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('PERIOD_NOT_FOUND')
  })

  it('returns the completed year-end result', async () => {
    const { status, body } = await parseJsonResponse<{ data: { closingEntry: { id: string } } }>(
      await POST(request(), params),
    )

    expect(status).toBe(200)
    expect(body.data.closingEntry.id).toBe('closing-1')
    expect(executeYearEndClosing).toHaveBeenCalledWith(
      {},
      'company-1',
      'user-1',
      'period-1',
    )
  })
})
