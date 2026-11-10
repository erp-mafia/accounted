import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase: queuedSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
// Swappable so one test can use a capturing client to inspect the update payload.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let activeSupabase: any = queuedSupabase

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(activeSupabase),
  createServiceClient: () => activeSupabase,
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const executeRecurringSchedule = vi.fn()
vi.mock('@/lib/invoices/recurring-schedule-service', () => ({
  executeRecurringSchedule: (...args: unknown[]) => executeRecurringSchedule(...args),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const params = { params: Promise.resolve({ id: 's-1' }) }
const req = () => createMockRequest('/api/invoices/recurring/s-1/run', { method: 'POST' })

describe('POST /api/invoices/recurring/[id]/run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    activeSupabase = queuedSupabase
    queuedSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    queuedSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status } = await parseJsonResponse(await POST(req(), params))
    expect(status).toBe(401)
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
  })

  it('returns 404 when the schedule does not exist', async () => {
    enqueue({ data: null, error: null })
    const { status, body } = await parseJsonResponse<{ type: string }>(await POST(req(), params))
    expect(status).toBe(404)
    expect(body.type).toBe('not_found')
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
  })

  it('generates an invoice and returns it', async () => {
    enqueue({
      data: { id: 's-1', company_id: 'company-1', generated_count: 2, items: [] },
      error: null,
    })
    enqueue({ data: [{ id: 's-1' }], error: null }) // run claim
    enqueue({ error: null }) // tracking update
    executeRecurringSchedule.mockResolvedValue({
      invoiceId: 'inv-9',
      invoiceNumber: 'F-9',
      autoSent: false,
      warning: null,
    })

    const { status, body } = await parseJsonResponse<{ data: { invoiceId: string } }>(
      await POST(req(), params),
    )
    expect(status).toBe(200)
    expect(body.data.invoiceId).toBe('inv-9')
    expect(executeRecurringSchedule).toHaveBeenCalledTimes(1)
  })

  it('records the run but never touches next_run_date (keeps the monthly cadence)', async () => {
    const updatePayloads: Record<string, unknown>[] = []
    const scheduleRow = {
      id: 's-1',
      company_id: 'company-1',
      generated_count: 0,
      next_run_date: '2026-08-05',
      items: [],
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      update: (payload: Record<string, unknown>) => {
        updatePayloads.push(payload)
        return chain
      },
      eq: () => chain,
      is: () => chain,
      single: () => Promise.resolve({ data: scheduleRow, error: null }),
      // The run claim reads back its row; the tracking update reads only error.
      then: (resolve: (v: unknown) => void) => resolve({ data: [{ id: 's-1' }], error: null }),
    }
    activeSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
      from: vi.fn(() => chain),
    }
    executeRecurringSchedule.mockResolvedValue({
      invoiceId: 'inv-1',
      invoiceNumber: 'F-1',
      autoSent: false,
      warning: null,
    })

    const { status } = await parseJsonResponse(await POST(req(), params))
    expect(status).toBe(200)
    // The run claim, then the tracking update.
    expect(updatePayloads).toHaveLength(2)
    expect(Object.keys(updatePayloads[0])).toEqual(['last_run_at'])
    expect(updatePayloads[1]).not.toHaveProperty('next_run_date')
    expect(updatePayloads[1]).toHaveProperty('generated_count', 1)
  })
})

describe('POST /api/invoices/recurring/[id]/run: billing period', () => {
  it('advances period_start (the invoice just created covers it) while leaving next_run_date alone', async () => {
    const updatePayloads: Record<string, unknown>[] = []
    const scheduleRow = {
      id: 's-1',
      company_id: 'company-1',
      generated_count: 0,
      interval_months: 12,
      next_run_date: '2026-10-01',
      period_start: '2026-10-01',
      items: [],
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      update: (payload: Record<string, unknown>) => {
        updatePayloads.push(payload)
        return chain
      },
      eq: () => chain,
      is: () => chain,
      single: () => Promise.resolve({ data: scheduleRow, error: null }),
      // The run claim reads back its row; the tracking update reads only error.
      then: (resolve: (v: unknown) => void) => resolve({ data: [{ id: 's-1' }], error: null }),
    }
    activeSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
      from: vi.fn(() => chain),
    }
    executeRecurringSchedule.mockResolvedValue({ invoiceId: 'inv-1', invoiceNumber: 'F-1', autoSent: false, warning: null })

    const { status } = await parseJsonResponse(await POST(req(), params))
    expect(status).toBe(200)
    expect(updatePayloads).toHaveLength(2)
    expect(updatePayloads[1].period_start).toBe('2027-10-01')
    expect(updatePayloads[1]).not.toHaveProperty('next_run_date')
  })

  it('records an unnumbered draft run: last_invoice_id points at the draft so removing it can give the period back (crm#1285)', async () => {
    const updatePayloads: Record<string, unknown>[] = []
    const scheduleRow = {
      id: 's-1',
      company_id: 'company-1',
      generated_count: 0,
      interval_months: 1,
      next_run_date: '2026-11-01',
      period_start: '2026-10-01',
      items: [],
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      update: (payload: Record<string, unknown>) => {
        updatePayloads.push(payload)
        return chain
      },
      eq: () => chain,
      is: () => chain,
      single: () => Promise.resolve({ data: scheduleRow, error: null }),
      // The run claim reads back its row; the tracking update reads only error.
      then: (resolve: (v: unknown) => void) => resolve({ data: [{ id: 's-1' }], error: null }),
    }
    activeSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
      from: vi.fn(() => chain),
    }
    // No auto_send: the draft is created unnumbered (numbered when issued).
    executeRecurringSchedule.mockResolvedValue({ invoiceId: 'inv-draft', invoiceNumber: null, autoSent: false, warning: null })

    const { status, body } = await parseJsonResponse<{ data: { invoiceNumber: string | null } }>(
      await POST(req(), params),
    )
    expect(status).toBe(200)
    expect(body.data.invoiceNumber).toBeNull()
    expect(updatePayloads[1]).toMatchObject({ last_invoice_id: 'inv-draft', period_start: '2026-11-01' })
    expect(updatePayloads[1]).not.toHaveProperty('next_run_date')
  })
})

// accounted#58: "Skapa faktura nu" had no claim, so a second click from another
// tab, or the hourly cron reaching the schedule meanwhile, created a second
// invoice (with auto_send, a second booked and emailed one). It now claims the
// run on last_run_at exactly as the cron does.
describe('POST /api/invoices/recurring/[id]/run: one run at a time', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    activeSupabase = queuedSupabase
    queuedSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  const scheduleRow = {
    id: 's-1',
    company_id: 'company-1',
    generated_count: 2,
    last_run_at: '2026-10-01T06:00:00.000Z',
    items: [],
  }

  it('409 RECURRING_RUN_IN_PROGRESS when another run holds the claim, creating nothing', async () => {
    enqueue({ data: scheduleRow, error: null })
    enqueue({ data: [], error: null }) // the claim matched no row: last_run_at moved

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await POST(req(), params))

    expect(status).toBe(409)
    expect(body.error.code).toBe('RECURRING_RUN_IN_PROGRESS')
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
  })

  it('claims on the last_run_at it read, so only one of two concurrent runs gets the row', async () => {
    enqueue({ data: scheduleRow, error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    enqueue({ error: null })
    executeRecurringSchedule.mockResolvedValue({ invoiceId: 'inv-9', invoiceNumber: 'F-9', autoSent: false, warning: null })

    const { status } = await parseJsonResponse(await POST(req(), params))

    expect(status).toBe(200)
    expect(findCalls('recurring_invoice_schedules', 'eq')).toContainEqual(['last_run_at', '2026-10-01T06:00:00.000Z'])
    expect(findCalls('recurring_invoice_schedules', 'update')[0][0]).toEqual({ last_run_at: expect.any(String) })
  })

  it('gives the claim back when the invoice cannot be created, and answers the failure', async () => {
    enqueue({ data: scheduleRow, error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    enqueue({ error: null }) // release
    executeRecurringSchedule.mockRejectedValue(new Error('customer not found for schedule s-1'))

    const { status } = await parseJsonResponse(await POST(req(), params))

    expect(status).toBeGreaterThanOrEqual(400)
    const updates = findCalls('recurring_invoice_schedules', 'update')
    expect(updates).toHaveLength(2)
    const claimTs = (updates[0][0] as { last_run_at: string }).last_run_at
    // The release restores what was read, only while the row still holds this claim.
    expect(updates[1][0]).toEqual({ last_run_at: '2026-10-01T06:00:00.000Z' })
    expect(findCalls('recurring_invoice_schedules', 'eq')).toContainEqual(['last_run_at', claimTs])
  })

  it('answers a failed claim write as an error and creates nothing', async () => {
    enqueue({ data: scheduleRow, error: null })
    enqueue({ data: null, error: { message: 'connection reset' } })

    const { status } = await parseJsonResponse(await POST(req(), params))

    expect(status).toBeGreaterThanOrEqual(500)
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
  })
})
