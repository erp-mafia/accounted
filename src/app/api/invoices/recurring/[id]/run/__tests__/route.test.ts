import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls, calls } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(supabase),
  createServiceClient: () => supabase,
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: vi.fn(async () => false) }))

// Only the invoice-spawning function is stood in for; the date helpers and the
// error classes are the real ones.
const executeRecurringSchedule = vi.fn()
vi.mock('@/lib/invoices/recurring-schedule-service', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/invoices/recurring-schedule-service')>()),
  executeRecurringSchedule: (...args: unknown[]) => executeRecurringSchedule(...args),
}))

import { POST } from '../route'
import { RecurringInvoiceKeptError, RecurringRecordNotLandedError } from '@/lib/invoices/recurring-schedule-service'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const params = { params: Promise.resolve({ id: 's-1' }) }
const req = () => createMockRequest('/api/invoices/recurring/s-1/run', { method: 'POST' })

type RunOptions = { onInvoiceCreated?: (invoiceId: string) => Promise<void> }
type RunResult = { invoiceId: string; invoiceNumber: string | null; autoSent: boolean; warning: string | null }

/** The drafts the service would have removed (only on the hook's not-landed word). */
const removedDrafts: string[] = []

/**
 * The run as the real service performs it (pinned in
 * recurring-schedule-service.test.ts): the invoice exists, the route's hook
 * records it on the schedule, then the send answers. A hook that throws
 * RecurringRecordNotLandedError removes the draft and is rethrown; anything
 * else keeps it as RecurringInvoiceKeptError. `afterRecord` stands in for the
 * send.
 */
function runCreates(result: RunResult, afterRecord: () => void = () => {}) {
  executeRecurringSchedule.mockImplementation(
    async (_supabase: unknown, _schedule: unknown, _now: unknown, options: RunOptions) => {
      try {
        await options.onInvoiceCreated?.(result.invoiceId)
      } catch (err) {
        if (err instanceof RecurringRecordNotLandedError) {
          removedDrafts.push(result.invoiceId)
          throw err
        }
        throw new RecurringInvoiceKeptError(result.invoiceId, err)
      }
      afterRecord()
      return result
    },
  )
}

const INVOICE: RunResult = { invoiceId: 'inv-9', invoiceNumber: null, autoSent: false, warning: null }

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    company_id: 'company-1',
    status: 'active',
    day_of_month: 6,
    interval_months: 1,
    send_hour: 8,
    auto_send: false,
    next_run_date: '2026-11-06',
    period_start: '2026-11-01',
    last_run_at: '2026-10-06T07:00:00.000Z',
    last_run_warning: null,
    generated_count: 2,
    items: [],
    ...overrides,
  }
}

/** The UPDATE payloads written to the schedule, in order. */
const scheduleWrites = () => findCalls('recurring_invoice_schedules', 'update').map((args) => args[0] as Record<string, unknown>)

/** The filters of the n-th UPDATE of the schedule (0 = the claim). */
function filtersOfWrite(n: number): unknown[][] {
  const statements: unknown[][][] = []
  for (const call of calls.filter((c) => c.table === 'recurring_invoice_schedules')) {
    if (call.method === 'update') statements.push([])
    if (call.method === 'eq' || call.method === 'is') statements[statements.length - 1]?.push(call.args)
  }
  return statements[n] ?? []
}

const NOW = '2026-11-02T09:00:00.000Z' // 10:00 in Stockholm, ahead of the schedule's date

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  reset()
  removedDrafts.length = 0
  supabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/invoices/recurring/[id]/run', () => {
  it('returns 401 when not authenticated', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: null } })
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

  it('generates an invoice, records it on the schedule and returns it', async () => {
    enqueue({ data: makeSchedule(), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    enqueue({ data: [{ id: 's-1' }], error: null }) // record
    runCreates({ ...INVOICE, invoiceNumber: 'F-9' })

    const { status, body } = await parseJsonResponse<{ data: { invoiceId: string; invoiceNumber: string } }>(
      await POST(req(), params),
    )

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ invoiceId: 'inv-9', invoiceNumber: 'F-9' })
    expect(executeRecurringSchedule).toHaveBeenCalledTimes(1)
  })
})

// accounted#213: run-now recorded its run only after the send, with no claim
// gate, and a failed record was only logged. It now makes the cron's run
// (lib/invoices/recurring-schedule-run.ts).
describe('POST /api/invoices/recurring/[id]/run: the run is recorded before the send, like the hourly run', () => {
  it('the record is written before the send, gated on this run\'s claim, and moves the period on', async () => {
    enqueue({ data: makeSchedule(), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    enqueue({ data: [{ id: 's-1' }], error: null }) // record
    let writesAtSend: Record<string, unknown>[] = []
    runCreates(INVOICE, () => {
      writesAtSend = scheduleWrites()
    })

    await POST(req(), params)

    expect(writesAtSend).toHaveLength(2)
    expect(writesAtSend[1]).toEqual({
      // A token of the record's own, not the claim's.
      last_run_at: '2026-11-02T09:00:00.001Z',
      last_invoice_id: 'inv-9',
      last_run_warning: null,
      generated_count: 3,
      period_start: '2026-12-01',
    })
    expect(filtersOfWrite(1)).toEqual([
      ['id', 's-1'],
      ['company_id', 'company-1'],
      ['last_run_at', NOW],
    ])
  })

  it('ahead of the schedule\'s date, next_run_date is left alone (the cadence is not moved)', async () => {
    enqueue({ data: makeSchedule({ next_run_date: '2026-11-06' }), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    runCreates(INVOICE)

    await POST(req(), params)

    expect(scheduleWrites()[1]).not.toHaveProperty('next_run_date')
  })

  it('on or after the schedule\'s date, the run is the one that was due: next_run_date moves to the next date on its own grid', async () => {
    // A quarterly schedule whose 6 October run was held for a person.
    enqueue({ data: makeSchedule({ next_run_date: '2026-10-06', interval_months: 3, period_start: '2026-10-01' }), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    runCreates(INVOICE)

    await POST(req(), params)

    expect(scheduleWrites()[1]).toMatchObject({ next_run_date: '2027-01-06', period_start: '2027-01-01' })
  })

  it('on the schedule\'s own date, the next date is one interval on, never today', async () => {
    vi.setSystemTime(new Date('2026-11-06T06:00:00.000Z'))
    enqueue({ data: makeSchedule({ next_run_date: '2026-11-06' }), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    runCreates(INVOICE)

    await POST(req(), params)

    expect(scheduleWrites()[1]).toMatchObject({ next_run_date: '2026-12-06' })
  })

  it('a due date long past moves one interval on from that date, the cron\'s own rule: a date still past is the stale roll\'s to report, never skipped unseen', async () => {
    // Held since 6 September, resolved by hand on 2 November: 6 October has passed too.
    enqueue({ data: makeSchedule({ next_run_date: '2026-09-06', period_start: '2026-09-01' }), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    runCreates(INVOICE)

    await POST(req(), params)

    expect(scheduleWrites()[1]).toMatchObject({ next_run_date: '2026-10-06', period_start: '2026-10-01' })
  })

  it('the send\'s warning is written only while the schedule still holds this run\'s record', async () => {
    enqueue({ data: makeSchedule({ auto_send: true }), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    enqueue({ data: [{ id: 's-1' }], error: null }) // record
    enqueue({ data: [{ id: 's-1' }], error: null }) // the send's own warning
    runCreates({ ...INVOICE, autoSent: true })

    await POST(req(), params)

    // A run that claimed after this record (another tab) has written a held
    // warning this one must not erase.
    const record = scheduleWrites()[1]!
    expect(filtersOfWrite(2)).toEqual([
      ['id', 's-1'],
      ['company_id', 'company-1'],
      ['last_run_at', record.last_run_at],
    ])
  })

  it('loses its claim to another run while it creates its invoice: its draft is removed and it answers 409, a run is in progress', async () => {
    enqueue({ data: makeSchedule(), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    enqueue({ data: [], error: null }) // record: the claim is another run's now
    runCreates(INVOICE)

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await POST(req(), params))

    expect(removedDrafts).toEqual(['inv-9'])
    // Not "try again": the other run bills the period, and a retry would bill the next one early.
    expect(status).toBe(409)
    expect(body.error.code).toBe('RECURRING_RUN_IN_PROGRESS')
    // No hold and no release: the claim is the other run's.
    expect(scheduleWrites()).toHaveLength(2)
  })

  it('a failure after the record, without auto-send: the answer promises no note on the schedule, which has none', async () => {
    enqueue({ data: makeSchedule(), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    enqueue({ data: [{ id: 's-1' }], error: null }) // record
    executeRecurringSchedule.mockImplementation(
      async (_supabase: unknown, _schedule: unknown, _now: unknown, options: RunOptions) => {
        await options.onInvoiceCreated?.('inv-9')
        throw new RecurringInvoiceKeptError('inv-9', new Error('event bus unavailable'))
      },
    )

    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await POST(req(), params))

    expect(status).toBe(500)
    expect(body.error.code).toBe('RECURRING_RUN_INVOICE_KEPT')
    // The claim and the record, nothing after: the schedule names the invoice and shows no note.
    expect(scheduleWrites()).toHaveLength(2)
    expect(scheduleWrites()[1]!.last_run_warning).toBeNull()
    expect(body.error.message).toBe(
      'Fakturan kan ha skapats, men körningen kunde inte slutföras. Kontrollera bland fakturorna om den finns innan du försöker igen. Visar schemat en anvisning, följ den.',
    )
  })

  it('an auto-send schedule carries the "check that it went out" warning until the send answers', async () => {
    enqueue({ data: makeSchedule({ auto_send: true }), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    enqueue({ data: [{ id: 's-1' }], error: null }) // record
    enqueue({ data: [{ id: 's-1' }], error: null }) // the send's own warning
    runCreates({ ...INVOICE, autoSent: true })

    await POST(req(), params)

    const writes = scheduleWrites()
    expect(writes[1]!.last_run_warning).toContain('utskicket blev inte bekräftat')
    expect(writes[2]).toEqual({ last_run_warning: null })
  })

  it('the record answers an error and the hold lands: the draft is removed and the run given back as it was read', async () => {
    const before = 'Körningen 2026-10-06 misslyckades: x. Nytt försök görs automatiskt varje timme idag.'
    enqueue({ data: makeSchedule({ last_run_warning: before }), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    enqueue({ data: null, error: { message: 'connection refused' } }) // record
    enqueue({ data: [{ id: 's-1' }], error: null }) // hold
    enqueue({ data: [{ id: 's-1' }], error: null }) // release
    runCreates(INVOICE)

    const { status } = await parseJsonResponse(await POST(req(), params))

    expect(status).toBe(500)
    expect(removedDrafts).toEqual(['inv-9'])
    const writes = scheduleWrites()
    expect(writes[3]).toEqual({ last_run_at: '2026-10-06T07:00:00.000Z', last_run_warning: before })
    // Given back only from this run's hold.
    expect(filtersOfWrite(3)).toContainEqual(['last_run_at', writes[2]!.last_run_at])
  })

  it('the invoice is in place, or may be: the person is told to check before trying again, and the schedule stays held', async () => {
    enqueue({ data: makeSchedule(), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    enqueue({ data: null, error: null }) // the kept warning
    // A header insert whose answer was lost and whose read-back failed too.
    executeRecurringSchedule.mockRejectedValue(new RecurringInvoiceKeptError('inv-9', new Error('failed to insert invoice from schedule: reset')))

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await POST(req(), params))

    expect(status).toBe(500)
    expect(body.error.code).toBe('RECURRING_RUN_INVOICE_KEPT')
    const writes = scheduleWrites()
    // No release: last_run_at is not handed back.
    expect(writes).toHaveLength(2)
    expect(writes[1]!.last_run_warning).toContain('avbröts: failed to insert invoice from schedule: reset')
    expect(String(writes[1]!.last_run_warning)).toMatch(/väntar det tills du har gjort något av detta\.$/)
  })
})

// accounted#58: "Skapa faktura nu" had no claim, so a second click from another
// tab, or the hourly cron reaching the schedule meanwhile, created a second
// invoice (with auto_send, a second booked and emailed one). It claims the run
// on last_run_at exactly as the cron does.
describe('POST /api/invoices/recurring/[id]/run: one run at a time', () => {
  it('409 RECURRING_RUN_IN_PROGRESS when another run holds the claim, creating nothing', async () => {
    enqueue({ data: makeSchedule(), error: null })
    enqueue({ data: [], error: null }) // the claim matched no row: last_run_at moved

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await POST(req(), params))

    expect(status).toBe(409)
    expect(body.error.code).toBe('RECURRING_RUN_IN_PROGRESS')
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
  })

  it('claims on the last_run_at it read, writing the warning a person reads if the run never finishes', async () => {
    enqueue({ data: makeSchedule(), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    runCreates(INVOICE)

    const { status } = await parseJsonResponse(await POST(req(), params))

    expect(status).toBe(200)
    expect(filtersOfWrite(0)).toContainEqual(['last_run_at', '2026-10-06T07:00:00.000Z'])
    expect(scheduleWrites()[0]).toEqual({
      last_run_at: NOW,
      last_run_warning: expect.stringMatching(/^Körningen 2026-11-02 avslutades inte\..*väntar det tills du har gjort något av detta\.$/),
    })
  })

  it('gives the claim back when the invoice cannot be created, as the schedule was read, and answers the failure', async () => {
    enqueue({ data: makeSchedule(), error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    enqueue({ data: [{ id: 's-1' }], error: null }) // release
    executeRecurringSchedule.mockRejectedValue(new Error('customer not found for schedule s-1'))

    const { status } = await parseJsonResponse(await POST(req(), params))

    expect(status).toBeGreaterThanOrEqual(400)
    const writes = scheduleWrites()
    expect(writes).toHaveLength(2)
    // The release restores what was read, only while the row still holds this claim.
    expect(writes[1]).toEqual({ last_run_at: '2026-10-06T07:00:00.000Z', last_run_warning: null })
    expect(filtersOfWrite(1)).toContainEqual(['last_run_at', NOW])
  })

  it('answers a failed claim write as an error and creates nothing', async () => {
    enqueue({ data: makeSchedule(), error: null })
    enqueue({ data: null, error: { message: 'connection reset' } })

    const { status } = await parseJsonResponse(await POST(req(), params))

    expect(status).toBeGreaterThanOrEqual(500)
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
  })
})
