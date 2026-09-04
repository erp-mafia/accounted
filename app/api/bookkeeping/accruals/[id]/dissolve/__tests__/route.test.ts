import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import {
  AccrualNothingToDissolveError,
  AccrualScheduleNotActiveError,
  AccrualScheduleNotFoundError,
} from '@/lib/bookkeeping/accruals/errors'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
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

const mockDissolveScheduleNow = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  dissolveScheduleNow: (...args: unknown[]) => mockDissolveScheduleNow(...args),
}))

import { POST } from '../route'

describe('POST /api/bookkeeping/accruals/[id]/dissolve', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  function dissolveRequest() {
    return POST(
      createMockRequest('/api/bookkeeping/accruals/sched-1/dissolve', { method: 'POST' }),
      createMockRouteParams({ id: 'sched-1' }),
    )
  }

  it('returns the dissolution result on success', async () => {
    mockDissolveScheduleNow.mockResolvedValue({ journalEntryId: 'je-1', amount: 2000 })

    const { status, body } = await parseJsonResponse<{
      data: { journalEntryId: string; amount: number }
    }>(await dissolveRequest())

    expect(status).toBe(200)
    expect(body.data).toEqual({ journalEntryId: 'je-1', amount: 2000 })
  })

  it('maps the typed not-found error to 404 ACCRUAL_NOT_FOUND', async () => {
    mockDissolveScheduleNow.mockRejectedValue(new AccrualScheduleNotFoundError())

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await dissolveRequest(),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('ACCRUAL_NOT_FOUND')
  })

  it('maps the typed not-active error to 400 ACCRUAL_NOT_ACTIVE', async () => {
    mockDissolveScheduleNow.mockRejectedValue(new AccrualScheduleNotActiveError('cancelled'))

    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { currentStatus: string } }
    }>(await dissolveRequest())

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCRUAL_NOT_ACTIVE')
    expect(body.error.details.currentStatus).toBe('cancelled')
  })

  it('maps the typed nothing-to-dissolve error to 400 ACCRUAL_NOTHING_TO_DISSOLVE', async () => {
    mockDissolveScheduleNow.mockRejectedValue(new AccrualNothingToDissolveError())

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await dissolveRequest(),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCRUAL_NOTHING_TO_DISSOLVE')
  })

  it('falls back to ACCRUAL_DISSOLVE_FAILED for untyped errors, carrying a Swedish reason as-is', async () => {
    mockDissolveScheduleNow.mockRejectedValue(new Error('Ingen öppen räkenskapsperiod för 2026-01-01'))

    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { reason: string } }
    }>(await dissolveRequest())

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCRUAL_DISSOLVE_FAILED')
    // The engine's own Swedish sentence reaches the user (issue #2086); it
    // used to be dropped for lacking a getErrorMessage keyword.
    expect(body.error.details.reason).toBe('Ingen öppen räkenskapsperiod för 2026-01-01')
  })

  it('falls back to ACCRUAL_DISSOLVE_FAILED with the generic reason for untyped technical errors', async () => {
    mockDissolveScheduleNow.mockRejectedValue(new Error('boom'))

    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { reason: string } }
    }>(await dissolveRequest())

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCRUAL_DISSOLVE_FAILED')
    expect(body.error.details.reason).toBe('Något gick fel. Försök igen.')
  })
})
