import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase: queuedSupabase, enqueue, reset } = createQueuedMockSupabase()
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
      single: () => Promise.resolve({ data: scheduleRow, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ error: null }),
    }
    activeSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }) },
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
    expect(updatePayloads).toHaveLength(1)
    expect(updatePayloads[0]).not.toHaveProperty('next_run_date')
    expect(updatePayloads[0]).toHaveProperty('generated_count', 1)
  })
})
