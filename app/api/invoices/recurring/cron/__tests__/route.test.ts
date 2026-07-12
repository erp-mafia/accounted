import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mockSupabase,
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

// Cron auth always passes in these tests.
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: () => null }))

// Replace only the heavy invoice-spawning function; keep the real date helpers
// (getStockholmDateHour / computeNextRunDate / computeInitialRunDate).
const executeRecurringSchedule = vi.fn()
vi.mock('@/lib/invoices/recurring-schedule-service', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/invoices/recurring-schedule-service')>()
  return {
    ...actual,
    executeRecurringSchedule: (...args: unknown[]) => executeRecurringSchedule(...args),
  }
})

import { GET } from '../route'

type ResultRow = {
  scheduleId: string
  invoiceId?: string
  skipped?: boolean
  skipReason?: string
}
type CronBody = { success: boolean; succeeded: number; results: ResultRow[] }

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    company_id: 'c-1',
    day_of_month: 6,
    send_hour: 8,
    next_run_date: '2026-07-06',
    last_run_at: null,
    generated_count: 0,
    items: [],
    ...overrides,
  }
}

const req = () => createMockRequest('/api/invoices/recurring/cron', { method: 'GET' })

describe('GET /api/invoices/recurring/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a schedule due today once the Stockholm send hour has arrived', async () => {
    // 08:30 UTC = 10:30 Stockholm (CEST) -> hour 10 >= send_hour 8
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ send_hour: 8 })], error: null })
    // Atomic claim wins (returns the row it flipped).
    enqueue({ data: [{ id: 's-1' }], error: null })
    executeRecurringSchedule.mockResolvedValue({
      invoiceId: 'inv-1',
      invoiceNumber: 'F-1',
      autoSent: true,
      warning: null,
    })

    const { status, body } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(status).toBe(200)
    expect(executeRecurringSchedule).toHaveBeenCalledTimes(1)
    expect(body.succeeded).toBe(1)
    expect(body.results[0].invoiceId).toBe('inv-1')
  })

  it('skips when a concurrent cron run already claimed the schedule', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ send_hour: 8 })], error: null })
    // Atomic claim loses the race: the compare-and-set matched zero rows.
    enqueue({ data: [], error: null })

    const { body } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
    expect(body.results[0].skipReason).toBe('claimed_by_concurrent_run')
  })

  it('does not send before the chosen Stockholm hour', async () => {
    // 04:30 UTC = 06:30 Stockholm -> hour 6 < send_hour 8
    vi.setSystemTime(new Date('2026-07-06T04:30:00Z'))
    enqueue({ data: [makeSchedule({ send_hour: 8, next_run_date: '2026-07-06' })], error: null })

    const { body } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
    expect(body.results[0].skipReason).toBe('hour_not_reached')
  })

  it('rolls a past-due schedule forward WITHOUT sending (never invoices the past)', async () => {
    // Today Stockholm = 2026-07-06; schedule missed its 2026-07-05 date.
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ next_run_date: '2026-07-05', day_of_month: 5 })], error: null })

    const { body } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
    expect(body.results[0].skipReason).toBe('stale_rolled_forward')
  })

  it('skips a schedule that already ran earlier today', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({
      data: [makeSchedule({ last_run_at: '2026-07-06T06:15:00Z', send_hour: 8 })],
      error: null,
    })

    const { body } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
    expect(body.results[0].skipReason).toBe('already_ran_today')
  })
})
