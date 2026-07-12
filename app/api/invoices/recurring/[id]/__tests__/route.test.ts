import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

// Capturing mock: one shared chain whose .single() resolves the schedule row,
// whose bare await resolves { error: null }, and whose .update() records the
// payload so tests can assert exactly what gets written.
const updatePayloads: Record<string, unknown>[] = []
let scheduleRow: Record<string, unknown> | null = null
let customerRow: Record<string, unknown> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chain: any = {
  select: () => chain,
  update: (payload: Record<string, unknown>) => {
    updatePayloads.push(payload)
    return chain
  },
  delete: () => chain,
  insert: () => chain,
  eq: () => chain,
  single: () => Promise.resolve({ data: scheduleRow, error: null }),
  maybeSingle: () => Promise.resolve({ data: customerRow, error: null }),
  then: (resolve: (v: unknown) => void) => resolve({ error: null }),
}

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(() => chain),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { PATCH } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const params = { params: Promise.resolve({ id: 's-1' }) }
const patchReq = (body: unknown) =>
  createMockRequest('/api/invoices/recurring/s-1', { method: 'PATCH', body })

describe('PATCH /api/invoices/recurring/[id] reactivation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updatePayloads.length = 0
    customerRow = null
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    vi.useFakeTimers()
    // 08:30 UTC = 10:30 Stockholm (CEST) -> today is 2026-07-06 in Sweden.
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rolls a stale next_run_date forward and clears the warning on reactivation', async () => {
    scheduleRow = { next_run_date: '2026-07-05', day_of_month: 5 }

    const { status } = await parseJsonResponse(await PATCH(patchReq({ status: 'active' }), params))
    expect(status).toBe(200)
    expect(updatePayloads).toHaveLength(1)
    expect(updatePayloads[0]).toMatchObject({
      status: 'active',
      next_run_date: '2026-08-05',
      last_run_warning: null,
    })
  })

  it('rolls strictly into the future when reactivated on the schedule day itself', async () => {
    scheduleRow = { next_run_date: '2026-07-06', day_of_month: 6 }

    await PATCH(patchReq({ status: 'active' }), params)
    // Never today: today's invoice is the explicit run-now action instead.
    expect(updatePayloads[0].next_run_date).toBe('2026-08-06')
  })

  it('keeps a future next_run_date untouched but still clears the warning', async () => {
    scheduleRow = { next_run_date: '2026-07-20', day_of_month: 20 }

    await PATCH(patchReq({ status: 'active' }), params)
    expect(updatePayloads[0]).not.toHaveProperty('next_run_date')
    expect(updatePayloads[0]).toHaveProperty('last_run_warning', null)
  })

  it('recomputes next_run_date to the new day when day_of_month is edited', async () => {
    // Paused schedule, day 5 -> user edits to day 20. Today is 2026-07-06, so
    // the next day-20 occurrence is later this month.
    scheduleRow = { next_run_date: '2026-08-05', day_of_month: 5 }

    await PATCH(patchReq({ day_of_month: 20 }), params)
    expect(updatePayloads[0]).toMatchObject({ day_of_month: 20, next_run_date: '2026-07-20' })
    // Not a reactivation, so the warning is left as-is.
    expect(updatePayloads[0]).not.toHaveProperty('last_run_warning')
  })

  it('leaves next_run_date alone when the edited day is unchanged', async () => {
    scheduleRow = { next_run_date: '2026-07-20', day_of_month: 20 }

    await PATCH(patchReq({ day_of_month: 20, name: 'Renamed' }), params)
    expect(updatePayloads[0]).not.toHaveProperty('next_run_date')
    expect(updatePayloads[0]).toMatchObject({ day_of_month: 20, name: 'Renamed' })
  })

  it('does not touch next_run_date or warning when pausing', async () => {
    scheduleRow = { next_run_date: '2026-07-05', day_of_month: 5 }

    await PATCH(patchReq({ status: 'paused' }), params)
    expect(updatePayloads[0]).toEqual({ status: 'paused' })
  })

  it('returns 404 when reactivating a schedule that does not exist', async () => {
    scheduleRow = null

    const { status, body } = await parseJsonResponse<{ type: string }>(
      await PATCH(patchReq({ status: 'active' }), params),
    )
    expect(status).toBe(404)
    expect(body.type).toBe('not_found')
    expect(updatePayloads).toHaveLength(0)
  })

  it('rejects enabling auto_send when the customer has no email', async () => {
    scheduleRow = { auto_send: false, customer_id: 'c-1' }
    customerRow = { email: null }

    const { status, body } = await parseJsonResponse<{ type: string }>(
      await PATCH(patchReq({ auto_send: true }), params),
    )
    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
    expect(updatePayloads).toHaveLength(0)
  })

  it('allows enabling auto_send when the customer has an email', async () => {
    scheduleRow = { auto_send: false, customer_id: 'c-1' }
    customerRow = { email: 'kund@test.se' }

    const { status } = await parseJsonResponse(await PATCH(patchReq({ auto_send: true }), params))
    expect(status).toBe(200)
    expect(updatePayloads[0]).toEqual({ auto_send: true })
  })
})
