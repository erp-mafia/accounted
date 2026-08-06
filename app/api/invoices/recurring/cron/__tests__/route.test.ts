import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

// The queued mock's proxy chain discards call arguments, but these tests need
// to assert exactly what the cron writes back to the schedule row (claim
// release + failure warning, stale roll-forward warning). Wrap .from() so
// every .update() payload is recorded before delegating to the queue chain.
const updatePayloads: Array<{ table: string; payload: Record<string, unknown> }> = []
const baseFrom = mockSupabase.from.getMockImplementation()!
mockSupabase.from.mockImplementation((table: string) => {
  const chain = baseFrom(table) as Record<string, (...args: unknown[]) => unknown>
  return new Proxy(chain, {
    get(target, prop, receiver) {
      if (prop === 'update') {
        return (payload: Record<string, unknown>) => {
          updatePayloads.push({ table, payload })
          return target.update(payload)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
})

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

// Route-level sandbox resolution (defence in depth, ASVS V2.3).
const isSandboxCompany = vi.fn()
vi.mock('@/lib/sandbox/guard', () => ({
  isSandboxCompany: (...args: unknown[]) => isSandboxCompany(...args),
}))

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
    interval_months: 1,
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
    updatePayloads.length = 0
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
    // No auto_send on the schedule -> no sandbox lookup, no suppression.
    expect(isSandboxCompany).not.toHaveBeenCalled()
    expect(executeRecurringSchedule.mock.calls[0][3]).toEqual({ suppressAutoSend: false })
  })

  it('resolves the sandbox flag at the route level and suppresses auto-send for sandbox companies', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ send_hour: 8, auto_send: true })], error: null })
    // Atomic claim wins.
    enqueue({ data: [{ id: 's-1' }], error: null })
    isSandboxCompany.mockResolvedValue(true)
    executeRecurringSchedule.mockResolvedValue({
      invoiceId: 'inv-1',
      invoiceNumber: 'F-1',
      autoSent: false,
      warning: 'Auto-utskick misslyckades: fakturan finns som utkast och kan skickas manuellt.',
    })

    const { status } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(status).toBe(200)
    // Defence in depth: the route resolved the sandbox state itself and told
    // the service explicitly, instead of relying only on the chokepoint
    // inside sendInvoiceFromSchedule.
    expect(isSandboxCompany).toHaveBeenCalledWith(expect.anything(), 'c-1')
    expect(executeRecurringSchedule.mock.calls[0][3]).toEqual({ suppressAutoSend: true })
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

  it('releases the claim AND persists a failure warning when execution throws', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ send_hour: 8 })], error: null })
    // Atomic claim wins.
    enqueue({ data: [{ id: 's-1' }], error: null })
    executeRecurringSchedule.mockRejectedValue(new Error('VAT rate 25% not allowed'))
    // Claim release + warning write.
    enqueue({ data: null, error: null })

    const { body } = await parseJsonResponse<CronBody & { failed: number }>(await GET(req()))
    expect(body.failed).toBe(1)

    // The release update must restore the pre-claim last_run_at (null here)
    // so a later cron retries today, and carry a user-visible warning so a
    // deterministic failure never skips the month silently.
    const release = updatePayloads.find(
      (u) => u.table === 'recurring_invoice_schedules' && 'last_run_warning' in u.payload,
    )
    expect(release).toBeDefined()
    expect(release!.payload.last_run_at).toBeNull()
    expect(release!.payload.last_run_warning).toContain('2026-07-06 misslyckades')
    expect(release!.payload.last_run_warning).toContain('VAT rate 25% not allowed')
  })

  it('writes a skip warning when rolling a stale schedule forward', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ next_run_date: '2026-07-05', day_of_month: 5 })], error: null })
    // Roll-forward update.
    enqueue({ data: null, error: null })

    const { body } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(body.results[0].skipReason).toBe('stale_rolled_forward')

    const roll = updatePayloads.find((u) => u.table === 'recurring_invoice_schedules')
    expect(roll).toBeDefined()
    expect(roll!.payload.next_run_date).toBe('2026-08-05')
    expect(roll!.payload.last_run_warning).toContain('Ingen faktura skapades den 2026-07-05')
    expect(roll!.payload.last_run_warning).toContain('2026-08-05')
  })

  it('advances a quarterly schedule one quarter after a successful run', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ interval_months: 3 })], error: null })
    // Atomic claim wins.
    enqueue({ data: [{ id: 's-1' }], error: null })
    executeRecurringSchedule.mockResolvedValue({
      invoiceId: 'inv-1',
      invoiceNumber: 'F-1',
      autoSent: true,
      warning: null,
    })

    const { body } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(body.succeeded).toBe(1)

    const bump = updatePayloads.find(
      (u) => u.table === 'recurring_invoice_schedules' && 'next_run_date' in u.payload,
    )
    expect(bump).toBeDefined()
    expect(bump!.payload.next_run_date).toBe('2026-10-06')
  })

  it('rolls a stale quarterly schedule forward on its own quarter grid', async () => {
    // Quarterly Jan/Apr/Jul/Oct schedule missed Apr 5 (long outage or pause);
    // today is Jul 6. The next slot on the grid is Oct 5 (Jul 5 already
    // passed), NOT Aug 5 as a today-anchored monthly roll would give.
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({
      data: [makeSchedule({ next_run_date: '2026-04-05', day_of_month: 5, interval_months: 3 })],
      error: null,
    })
    // Roll-forward update.
    enqueue({ data: null, error: null })

    const { body } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
    expect(body.results[0].skipReason).toBe('stale_rolled_forward')

    const roll = updatePayloads.find((u) => u.table === 'recurring_invoice_schedules')
    expect(roll).toBeDefined()
    expect(roll!.payload.next_run_date).toBe('2026-10-05')
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
