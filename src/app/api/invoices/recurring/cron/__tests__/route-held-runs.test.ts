/**
 * GET /api/invoices/recurring/cron: a run that is cut short, at any step,
 * never leaves a schedule that bills the same period twice.
 *
 * One schedule row lives in memory and only the UPDATEs that land change it,
 * as Postgres would: each is matched on its filters, applied, and answered.
 * A step can fail without landing (the database is down), land with its
 * answer lost (a dropped connection after the commit), or be the last thing
 * that happens (the function is killed: nothing after it lands, the draft
 * removal included). The service is stood in for as its contract is pinned in
 * recurring-schedule-service.test.ts: the invoice exists once
 * executeRecurringSchedule has created it; RecurringRecordNotLandedError
 * removes it and is rethrown only when the removal is confirmed; anything
 * else keeps it as RecurringInvoiceKeptError.
 *
 * After the cut, the cron runs again later the same day, the next day and the
 * day after, with the database up. The period must never have two invoices,
 * and a schedule that may have one it does not record must wait for a
 * person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase } from '@/tests/helpers'

type Chain = Array<{ method: string; args: unknown[] }>
type Row = Record<string, unknown>

/** What happens to the n-th UPDATE of the schedule (1 = the claim). */
type WriteFate = 'lands' | 'down' | 'lost'

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  /** Invoices that exist for the period (unnumbered drafts here). */
  invoices: new Set<string>(),
  created: 0,
  writes: 0,
  fates: new Map<number, 'lands' | 'down' | 'lost'>(),
  /** The function is killed once this write has landed: nothing after it lands. */
  killAfterWrite: null as number | null,
  /** The function is killed right after the invoice was created. */
  killAfterInvoice: false,
  /** The function is killed right after the draft was removed. */
  killAfterRemoval: false,
  killed: false,
}))

function filtersHold(row: Row, chain: Chain): boolean {
  return chain.every((c) => {
    if (c.method === 'eq') return row[c.args[0] as string] === c.args[1]
    if (c.method === 'is') return row[c.args[0] as string] === c.args[1]
    return true
  })
}

const schedules = (chain: Chain) => {
  const update = chain.find((c) => c.method === 'update')
  if (!update) {
    const lte = chain.find((c) => c.method === 'lte')
    if (!lte) {
      // The read-back of a record whose answer was an error: the row, when it matches.
      if (state.killed) return { data: null, error: { message: 'connection refused' } }
      return { data: filtersHold(state.row, chain) ? [{ id: state.row.id }] : [] }
    }
    // The due read (fetchAllRows): active and due on or before today.
    const due = state.row.status === 'active' && (state.row.next_run_date as string) <= (lte.args[1] as string)
    return { data: due ? [{ ...state.row, items: [] }] : [] }
  }
  state.writes += 1
  const n = state.writes
  const fate: WriteFate = state.killed ? 'down' : (state.fates.get(n) ?? 'lands')
  if (fate === 'down') return { data: null, error: { message: 'connection refused' } }
  const matched = filtersHold(state.row, chain)
  if (matched) Object.assign(state.row, update.args[0] as Row)
  if (state.killAfterWrite === n) state.killed = true
  if (fate === 'lost') return { data: null, error: { message: 'connection reset by peer' } }
  return { data: matched ? [{ id: state.row.id }] : [] }
}

const db = createTableMockSupabase({ recurring_invoice_schedules: schedules })

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => db.supabase }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: () => null }))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: vi.fn(async () => false) }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return { ...(await importOriginal<typeof import('@/lib/logger')>()), createLogger: () => log }
})

const executeRecurringSchedule = vi.fn()
vi.mock('@/lib/invoices/recurring-schedule-service', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/invoices/recurring-schedule-service')>()
  return { ...actual, executeRecurringSchedule: (...args: unknown[]) => executeRecurringSchedule(...args) }
})

const { GET } = await import('../route')
const { RecurringInvoiceKeptError, RecurringRecordNotLandedError } = await import('@/lib/invoices/recurring-schedule-service')

type RunOptions = { onInvoiceCreated?: (invoiceId: string) => Promise<void> }

/** The service, as its contract is pinned in recurring-schedule-service.test.ts. */
async function serviceRun(_supabase: unknown, _schedule: unknown, _now: unknown, options: RunOptions) {
  if (state.killed) throw new Error('killed')
  state.created += 1
  const invoiceId = `inv-${state.created}`
  state.invoices.add(invoiceId)
  if (state.killAfterInvoice) {
    state.killed = true
    throw new Error('killed')
  }
  try {
    await options.onInvoiceCreated?.(invoiceId)
  } catch (err) {
    if (err instanceof RecurringRecordNotLandedError) {
      const removed = !state.killed
      if (removed) state.invoices.delete(invoiceId)
      if (state.killAfterRemoval) state.killed = true
      if (removed) throw err
    }
    throw new RecurringInvoiceKeptError(invoiceId, err)
  }
  return { invoiceId, invoiceNumber: null, autoSent: false, warning: null }
}

const HELD = 'Har schemat inte flyttats till nästa körning väntar det tills du har gjort något av detta.'

/** Run the cron at `instant` (UTC), with whatever fates are set. */
async function cronAt(instant: string) {
  vi.setSystemTime(new Date(instant))
  const res = await GET(createMockRequest('/api/invoices/recurring/cron', { method: 'GET' }))
  return (await res.json()) as { results: Array<{ skipReason?: string; invoiceId?: string }> }
}

/** The first run, cut short as set up, then three more with the database up. */
async function cutRunThenCarryOn() {
  await cronAt('2026-07-06T08:30:00Z') // 10:30 Stockholm, the schedule's day and past its hour
  state.fates.clear()
  state.killAfterWrite = null
  state.killAfterInvoice = false
  state.killAfterRemoval = false
  state.killed = false
  const later = await cronAt('2026-07-06T11:30:00Z')
  const nextDay = await cronAt('2026-07-07T08:30:00Z')
  const dayAfter = await cronAt('2026-07-08T08:30:00Z')
  return { later, nextDay, dayAfter }
}

beforeEach(() => {
  vi.useFakeTimers()
  executeRecurringSchedule.mockReset()
  executeRecurringSchedule.mockImplementation(serviceRun)
  state.row = {
    id: 's-1',
    company_id: 'c-1',
    status: 'active',
    day_of_month: 6,
    interval_months: 1,
    send_hour: 8,
    next_run_date: '2026-07-06',
    period_start: '2026-07-01',
    last_run_at: '2026-06-06T06:30:00.000Z',
    last_invoice_id: null,
    last_run_warning: null,
    generated_count: 4,
    auto_send: false,
  }
  state.invoices = new Set()
  state.created = 0
  state.writes = 0
  state.fates = new Map()
  state.killAfterWrite = null
  state.killAfterInvoice = false
  state.killAfterRemoval = false
  state.killed = false
})

afterEach(() => {
  vi.useRealTimers()
})

/** A schedule that may have an invoice it does not record is held: no run bills it again. */
function expectHeldForAPerson() {
  expect(state.row.next_run_date).toBe('2026-07-06')
  expect(state.row.period_start).toBe('2026-07-01')
  expect(String(state.row.last_run_warning).endsWith(HELD)).toBe(true)
}

describe('a recurring run cut short never bills its period twice', () => {
  it('as a control: a run that goes through bills the period once and moves the schedule on', async () => {
    const { later, nextDay } = await cutRunThenCarryOn()

    expect(state.invoices.size).toBe(1)
    expect(state.row).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01', last_invoice_id: 'inv-1', last_run_warning: null })
    expect(later.results).toEqual([])
    expect(nextDay.results).toEqual([])
  })

  it('the claim\'s answer lost after it landed: nothing is created, and the schedule waits for a person rather than guess', async () => {
    state.fates.set(1, 'lost')

    const { later, nextDay } = await cutRunThenCarryOn()

    expect(state.created).toBe(0)
    expectHeldForAPerson()
    expect(later.results.map((r) => r.skipReason)).toEqual(['already_ran_today'])
    expect(nextDay.results.map((r) => r.skipReason)).toEqual(['held_for_a_person'])
  })

  it('the record\'s answer lost after it landed: the read-back finds it and the run goes on, nothing is billed again', async () => {
    state.fates.set(2, 'lost')

    await cutRunThenCarryOn()

    expect(state.created).toBe(1)
    expect(state.invoices).toEqual(new Set(['inv-1']))
    // No kept warning: the run finished as if the answer had arrived (accounted#211).
    expect(state.row).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01', last_invoice_id: 'inv-1', last_run_warning: null })
  })

  it('the hold\'s answer lost after it landed: the draft is kept and the schedule held, nothing is billed again', async () => {
    state.fates.set(2, 'down') // the record never landed
    state.fates.set(3, 'lost') // the hold landed, its answer did not arrive

    const { later, nextDay, dayAfter } = await cutRunThenCarryOn()

    expect(state.created).toBe(1)
    expect(state.invoices).toEqual(new Set(['inv-1']))
    expectHeldForAPerson()
    expect(later.results.map((r) => r.skipReason)).toEqual(['already_ran_today'])
    expect(nextDay.results.map((r) => r.skipReason)).toEqual(['held_for_a_person'])
    expect(dayAfter.results.map((r) => r.skipReason)).toEqual(['held_for_a_person'])
  })

  it('the database down for the record, the hold and the warning: the claim holds the schedule, nothing is billed again', async () => {
    state.fates.set(2, 'down')
    state.fates.set(3, 'down')
    state.fates.set(4, 'down')

    const { later, nextDay } = await cutRunThenCarryOn()

    expect(state.created).toBe(1)
    expect(state.invoices).toEqual(new Set(['inv-1']))
    // The claim's own warning, written before anything was created, holds it.
    expectHeldForAPerson()
    expect(later.results.map((r) => r.skipReason)).toEqual(['already_ran_today'])
    expect(nextDay.results.map((r) => r.skipReason)).toEqual(['held_for_a_person'])
  })

  describe('killed after each step', () => {
    it('after the claim: nothing was created and the schedule waits for a person', async () => {
      state.killAfterWrite = 1

      await cutRunThenCarryOn()

      expect(state.created).toBe(0)
      expectHeldForAPerson()
    })

    it('after the invoice was created, before the record: one invoice, the schedule held', async () => {
      state.killAfterInvoice = true

      await cutRunThenCarryOn()

      expect(state.created).toBe(1)
      expect(state.invoices).toEqual(new Set(['inv-1']))
      expectHeldForAPerson()
    })

    it('after the record: the period is billed once and the schedule has moved on', async () => {
      state.killAfterWrite = 2

      await cutRunThenCarryOn()

      expect(state.created).toBe(1)
      expect(state.invoices).toEqual(new Set(['inv-1']))
      expect(state.row).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01' })
    })

    it('after the hold (the record\'s answer was an error): the draft is kept and the schedule held', async () => {
      state.fates.set(2, 'down')
      state.killAfterWrite = 3

      await cutRunThenCarryOn()

      expect(state.created).toBe(1)
      expect(state.invoices).toEqual(new Set(['inv-1']))
      expectHeldForAPerson()
    })

    it('after the draft was removed, before the release: no invoice, the schedule held, nothing billed behind a person\'s back', async () => {
      state.fates.set(2, 'down')
      state.killAfterRemoval = true

      await cutRunThenCarryOn()

      expect(state.created).toBe(1)
      expect(state.invoices).toEqual(new Set())
      expectHeldForAPerson()
    })

    it('after the release: the next hour bills the period, once', async () => {
      state.fates.set(2, 'down')
      state.killAfterWrite = 4

      const { later } = await cutRunThenCarryOn()

      // The first draft is gone; the retry made the period's one invoice.
      expect(state.created).toBe(2)
      expect(state.invoices).toEqual(new Set(['inv-2']))
      expect(later.results.map((r) => r.invoiceId)).toEqual(['inv-2'])
      expect(state.row).toMatchObject({ next_run_date: '2026-08-06', period_start: '2026-08-01', last_invoice_id: 'inv-2' })
    })
  })
})
