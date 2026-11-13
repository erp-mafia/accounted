import fs from 'fs'
import path from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls, calls } = createQueuedMockSupabase()

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

// log.error is what reaches the error tracker: a held schedule is asserted on it.
const cronLog = vi.hoisted(() => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return log
})
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  createLogger: () => cronLog,
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
import { RecurringInvoiceKeptError, RecurringRecordNotLandedError } from '@/lib/invoices/recurring-schedule-service'

type RunOptions = { suppressAutoSend?: boolean; onInvoiceCreated?: (invoiceId: string) => Promise<void> }
type RunResult = { invoiceId: string; invoiceNumber: string | null; autoSent: boolean; warning: string | null }

/** The drafts the service would have removed (only on the hook's not-landed word). */
const removedDrafts: string[] = []

type Answer = { data?: unknown; error?: unknown }
/** The record landed: the schedule still held this run's claim and took it. */
const RECORDED: Answer[] = [{ data: [{ id: 's-1' }] }]

/**
 * The run as the real service performs it: the invoice exists, the route's
 * onInvoiceCreated records it on the schedule, then the send answers. A hook
 * that throws is answered as the service answers it (pinned in
 * recurring-schedule-service.test.ts): RecurringRecordNotLandedError removes
 * the draft and is rethrown once the removal is confirmed (else the draft is
 * kept), anything else keeps it as RecurringInvoiceKeptError. `record` is
 * what the database answers the record and the statements after it (the
 * hold, then the release or the kept warning); `duringSend` stands in for
 * what happens while sending. route-held-runs.test.ts runs the same steps
 * against a schedule row that keeps what lands.
 */
function runCreates(
  result: RunResult,
  duringSend: () => void | Promise<void> = () => {},
  record: Answer[] = RECORDED,
  removal: 'confirmed' | 'not confirmed' = 'confirmed',
) {
  for (const answer of record) enqueue({ error: null, ...answer })
  executeRecurringSchedule.mockImplementation(
    async (_supabase: unknown, _schedule: unknown, _now: unknown, options: RunOptions) => {
      try {
        await options.onInvoiceCreated?.(result.invoiceId)
      } catch (err) {
        if (err instanceof RecurringRecordNotLandedError && removal === 'confirmed') {
          removedDrafts.push(result.invoiceId)
          throw err
        }
        throw new RecurringInvoiceKeptError(result.invoiceId, err)
      }
      await duringSend()
      return result
    },
  )
}

/** The calls of each statement on the schedules table, split where an UPDATE begins. */
function scheduleUpdates(): Array<Array<{ method: string; args: unknown[] }>> {
  const statements: Array<Array<{ method: string; args: unknown[] }>> = []
  for (const call of calls.filter((c) => c.table === 'recurring_invoice_schedules')) {
    if (call.method === 'update') statements.push([])
    statements[statements.length - 1]?.push({ method: call.method, args: call.args })
  }
  return statements
}

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
    removedDrafts.length = 0
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
    runCreates({
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
    expect(executeRecurringSchedule.mock.calls[0][3]).toMatchObject({ suppressAutoSend: false })
  })

  it('resolves the sandbox flag at the route level and suppresses auto-send for sandbox companies', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ send_hour: 8, auto_send: true })], error: null })
    // Atomic claim wins.
    enqueue({ data: [{ id: 's-1' }], error: null })
    isSandboxCompany.mockResolvedValue(true)
    runCreates({
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
    expect(executeRecurringSchedule.mock.calls[0][3]).toMatchObject({ suppressAutoSend: true })
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
    const release = updatePayloads.filter((u) => u.table === 'recurring_invoice_schedules').at(-1)
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
    runCreates({
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

  it('records the invoice on the schedule before the send, so a run killed while sending is not forgotten', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ auto_send: true, period_start: '2026-07-01', generated_count: 4 })], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    isSandboxCompany.mockResolvedValue(false)
    // What the schedule row holds at the moment the send begins: a function
    // killed here writes nothing more.
    let atSend: Array<Record<string, unknown>> = []
    runCreates({ invoiceId: 'inv-1', invoiceNumber: 'F-1', autoSent: true, warning: null }, () => {
      atSend = updatePayloads.filter((u) => u.table === 'recurring_invoice_schedules').map((u) => u.payload)
    })

    await GET(req())

    // [0] is the claim; [1] is the record, complete before a mail is sent.
    expect(atSend).toHaveLength(2)
    expect(atSend[1]).toEqual({
      next_run_date: '2026-08-06',
      last_run_at: '2026-07-06T08:30:00.000Z',
      last_invoice_id: 'inv-1',
      generated_count: 5,
      period_start: '2026-08-01',
      // Tomorrow's roll cannot claim "Ingen faktura skapades": the schedule is no longer due.
      last_run_warning: expect.stringContaining('utskicket blev inte bekräftat'),
    })
    // Once the send has answered, its outcome replaces the provisional warning.
    const after = updatePayloads.filter((u) => u.table === 'recurring_invoice_schedules').map((u) => u.payload)
    expect(after[after.length - 1]).toEqual({ last_run_warning: null })
  })

  it('a draft-only schedule carries no send warning at any point', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ auto_send: false })], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    runCreates({ invoiceId: 'inv-1', invoiceNumber: null, autoSent: false, warning: null })

    await GET(req())

    const writes = updatePayloads.filter((u) => u.table === 'recurring_invoice_schedules').map((u) => u.payload)
    // The claim and the record: nothing to correct afterwards.
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ last_invoice_id: 'inv-1', last_run_warning: null })
  })

  it('the record is gated on this run\'s claim', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule()], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    runCreates({ invoiceId: 'inv-1', invoiceNumber: null, autoSent: false, warning: null })

    await GET(req())

    const [, record] = scheduleUpdates()
    expect(record!.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
      ['id', 's-1'],
      ['company_id', 'c-1'],
      ['last_run_at', '2026-07-06T08:30:00.000Z'],
    ])
  })

  it('the claim writes the warning a person reads if the run never finishes', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule()], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    runCreates({ invoiceId: 'inv-1', invoiceNumber: null, autoSent: false, warning: null })

    await GET(req())

    const [claim, record] = scheduleUpdates()
    expect(claim![0]!.args[0]).toEqual({
      last_run_at: '2026-07-06T08:30:00.000Z',
      // Each case with its own action: an unbilled period is billed with
      // "Skapa faktura nu"; a billed one needs its period start moved first,
      // or the next run bills it again.
      last_run_warning:
        'Körningen 2026-07-06 avslutades inte. Kontrollera om en faktura skapades för perioden. ' +
        'Om ingen skapades: använd "Skapa faktura nu". ' +
        'Om en skapades: se till att schemats periodstart (om den är ifylld) ligger efter fakturans period, ' +
        'och pausa och aktivera sedan schemat. ' +
        'Har schemat inte flyttats till nästa körning väntar det tills du har gjort något av detta.',
    })
    // The record replaces it once the invoice is on the schedule.
    expect(record![0]!.args[0]).toMatchObject({ last_invoice_id: 'inv-1', last_run_warning: null })
  })

  it('the held warning names the controls as the recurring invoices page labels them', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule()], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    runCreates({ invoiceId: 'inv-1', invoiceNumber: null, autoSent: false, warning: null })

    await GET(req())

    // A renamed button would leave the person looking for a control that is not there.
    const sv = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../../../messages/sv.json'), 'utf8'))
    const [claim] = scheduleUpdates()
    const text = (claim![0]!.args[0] as { last_run_warning: string }).last_run_warning
    expect(text).toContain(`"${sv.invoice_recurring.run_now}"`)
    expect(text).toContain(`${sv.invoice_recurring.pause.toLowerCase()} och ${sv.invoice_recurring.resume.toLowerCase()}`)
    expect(text).toContain(sv.invoice_recurring_new.period_start_label.toLowerCase())
  })

  it('a sandbox read that fails claims nothing: the next hourly run retries instead of finding the schedule held', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ auto_send: true })], error: null })
    isSandboxCompany.mockRejectedValueOnce(new Error('connection refused'))

    const { body } = await parseJsonResponse<CronBody & { failed: number }>(await GET(req()))

    expect(body.failed).toBe(1)
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
    // No claim, so no warning that asks a person to step in for a run that created nothing.
    expect(scheduleUpdates()).toEqual([])
  })

  describe('a record that answers an error (it may have landed, or still be on its way)', () => {
    const recordError = { error: { message: 'connection reset' } }

    it('did not land: held first, then the draft removed, then the run given back from the hold', async () => {
      vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
      enqueue({ data: [makeSchedule({ auto_send: true, period_start: '2026-07-01' })], error: null })
      enqueue({ data: [{ id: 's-1' }], error: null }) // claim
      isSandboxCompany.mockResolvedValue(false)
      const sent = vi.fn()
      // The record errors; the hold matches; the release from the hold lands.
      runCreates({ invoiceId: 'inv-1', invoiceNumber: 'F-1', autoSent: true, warning: null }, sent, [
        recordError,
        { data: [{ id: 's-1' }] },
        { data: [{ id: 's-1' }] },
      ])

      const { body } = await parseJsonResponse<CronBody & { failed: number }>(await GET(req()))

      expect(body.failed).toBe(1)
      expect(sent).not.toHaveBeenCalled()
      expect(removedDrafts).toEqual(['inv-1'])
      const [, , hold, release] = scheduleUpdates()
      // The hold: one UPDATE that moves the claim on and writes the held
      // warning, only while the run date and period are the ones read.
      const { last_run_at: holdTs, last_run_warning: heldText } = hold![0]!.args[0] as Record<string, string>
      expect(holdTs > '2026-07-06T08:30:00.000Z').toBe(true)
      expect(heldText).toMatch(/^Körningen 2026-07-06 avbröts: connection reset\. Kontrollera om en faktura skapades.*gjort något av detta\.$/)
      expect(hold!.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
        ['id', 's-1'],
        ['company_id', 'c-1'],
        ['last_run_at', '2026-07-06T08:30:00.000Z'],
        ['next_run_date', '2026-07-06'],
        ['period_start', '2026-07-01'],
      ])
      // Given back only after the removal, and only from the hold.
      expect(release![0]!.args[0]).toEqual({
        last_run_at: null,
        last_run_warning: expect.stringContaining('2026-07-06 misslyckades: schedule update failed for invoice inv-1: connection reset'),
      })
      expect(release!.filter((c) => c.method === 'eq').map((c) => c.args)).toContainEqual(['last_run_at', holdTs])
    })

    it('did not land but the draft is not confirmed gone: the run is not given back, the schedule stays held', async () => {
      vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
      enqueue({ data: [makeSchedule({ period_start: '2026-07-01' })], error: null })
      enqueue({ data: [{ id: 's-1' }], error: null }) // claim
      runCreates({ invoiceId: 'inv-1', invoiceNumber: null, autoSent: false, warning: null }, () => {}, [
        recordError,
        { data: [{ id: 's-1' }] }, // the hold
        { data: null }, // the kept warning
      ], 'not confirmed')

      const { body } = await parseJsonResponse<CronBody & { failed: number }>(await GET(req()))

      expect(body.failed).toBe(1)
      const statements = scheduleUpdates()
      // Claim, record, hold, kept warning: no release, so the hold stays.
      expect(statements).toHaveLength(4)
      expect(statements[3]![0]!.args[0]).toEqual({ last_run_warning: expect.stringContaining('gjort något av detta') })
    })

    it('landed before the hold: the hold matches nothing, the draft is kept and the user told to check', async () => {
      vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
      enqueue({ data: [makeSchedule({ auto_send: true, period_start: '2026-07-01' })], error: null })
      enqueue({ data: [{ id: 's-1' }], error: null }) // claim
      isSandboxCompany.mockResolvedValue(false)
      const sent = vi.fn()
      // The record committed (next_run_date and period_start moved on), so the hold matches no row.
      runCreates({ invoiceId: 'inv-1', invoiceNumber: 'F-1', autoSent: true, warning: null }, sent, [recordError, { data: [] }])

      const { body } = await parseJsonResponse<CronBody & { failed: number }>(await GET(req()))

      expect(body.failed).toBe(1)
      expect(sent).not.toHaveBeenCalled()
      // Never removed: removing it would leave a schedule moved on with no invoice for its period.
      expect(removedDrafts).toEqual([])
      const last = scheduleUpdates().at(-1)!
      expect(last[0]!.args[0]).toEqual({
        last_run_warning: expect.stringContaining('avbröts: the record of invoice inv-1 on the schedule is not confirmed (moved)'),
      })
    })

    it('nobody can tell (the hold errors too): the draft is kept and the claim held', async () => {
      vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
      enqueue({ data: [makeSchedule()], error: null })
      enqueue({ data: [{ id: 's-1' }], error: null }) // claim
      runCreates({ invoiceId: 'inv-1', invoiceNumber: null, autoSent: false, warning: null }, () => {}, [
        recordError,
        { error: { message: 'connection reset' } },
      ])

      const { body } = await parseJsonResponse<CronBody & { failed: number }>(await GET(req()))

      expect(body.failed).toBe(1)
      expect(removedDrafts).toEqual([])
    })
  })

  it('a record that finds the claim gone (another run took it): the draft is removed and the claim is not touched', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule()], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    runCreates({ invoiceId: 'inv-1', invoiceNumber: null, autoSent: false, warning: null }, () => {}, [{ data: [] }])

    const { body } = await parseJsonResponse<CronBody & { failed: number }>(await GET(req()))

    expect(body.failed).toBe(1)
    expect(removedDrafts).toEqual(['inv-1'])
    // No hold and no release: the claim and the record only, the claim is another run's.
    expect(scheduleUpdates()).toHaveLength(2)
  })

  it('a failure with the invoice in place keeps the claim and tells the user to check the invoice', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ auto_send: true })], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim
    isSandboxCompany.mockResolvedValue(false)
    // What the service throws once the invoice exists and stays: here after the record landed.
    runCreates({ invoiceId: 'inv-1', invoiceNumber: 'F-1', autoSent: true, warning: null }, () => {
      throw new RecurringInvoiceKeptError('inv-1', new Error('event bus unavailable'))
    })

    const { body } = await parseJsonResponse<CronBody & { failed: number }>(await GET(req()))

    expect(body.failed).toBe(1)
    expect(removedDrafts).toEqual([])
    const writes = updatePayloads.filter((u) => u.table === 'recurring_invoice_schedules').map((u) => u.payload)
    const last = writes[writes.length - 1]!
    // No release: last_run_at is not handed back, so no second invoice today.
    expect('last_run_at' in last).toBe(false)
    expect(last.last_run_warning).toContain('avbröts: event bus unavailable')
    expect(last.last_run_warning).toContain('Kontrollera om en faktura skapades för perioden')
  })

  describe('a schedule its last run left for a person', () => {
    const HELD =
      'Körningen 2026-07-05 avbröts: connection reset. Kontrollera om en faktura skapades för perioden. ' +
      'Om ingen skapades: använd "Skapa faktura nu". ' +
      'Om en skapades: se till att schemats periodstart (om den är ifylld) ligger efter fakturans period, ' +
      'och pausa och aktivera sedan schemat. ' +
      'Har schemat inte flyttats till nästa körning väntar det tills du har gjort något av detta.'

    it('is not rolled and gets no new warning: no false "Ingen faktura skapades", no second invoice for the period', async () => {
      vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
      enqueue({ data: [makeSchedule({ next_run_date: '2026-07-05', day_of_month: 5, last_run_warning: HELD })], error: null })

      const { body } = await parseJsonResponse<CronBody>(await GET(req()))

      expect(body.results).toEqual([{ scheduleId: 's-1', skipped: true, skipReason: 'held_for_a_person' }])
      expect(updatePayloads).toEqual([])
      expect(executeRecurringSchedule).not.toHaveBeenCalled()
    })

    it('says so as an error once: at its hour on the day after the missed date, not on the hours or days after', async () => {
      const runAt = async (instant: string) => {
        vi.setSystemTime(new Date(instant))
        enqueue({ data: [makeSchedule({ next_run_date: '2026-07-05', day_of_month: 5, send_hour: 8, last_run_warning: HELD })], error: null })
        await GET(req())
      }
      // 06:30 UTC = 08:30 Stockholm (CEST) on 6 July: the hour of the schedule, the day after.
      await runAt('2026-07-06T06:30:00Z')
      await runAt('2026-07-06T07:30:00Z')
      await runAt('2026-07-07T06:30:00Z')

      const held = cronLog.error.mock.calls.filter(([message]) => String(message).includes('held for a person'))
      expect(held).toHaveLength(1)
    })

    it('a stale schedule with any other warning is rolled forward as before', async () => {
      vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
      enqueue({
        data: [makeSchedule({ next_run_date: '2026-07-05', day_of_month: 5, last_run_warning: 'Körningen 2026-07-05 misslyckades: x. Nytt försök görs automatiskt varje timme idag.' })],
        error: null,
      })
      enqueue({ data: null, error: null })

      const { body } = await parseJsonResponse<CronBody>(await GET(req()))

      expect(body.results[0].skipReason).toBe('stale_rolled_forward')
    })
  })

  it('reads the due schedules in a stable order, a page at a time', async () => {
    vi.setSystemTime(new Date('2026-07-06T04:30:00Z'))
    enqueue({ data: [makeSchedule({ send_hour: 8 })], error: null })

    await GET(req())

    expect(findCalls('recurring_invoice_schedules', 'order')).toEqual([
      ['next_run_date', { ascending: true }],
      ['id', { ascending: true }],
    ])
    expect(findCalls('recurring_invoice_schedules', 'range')).toEqual([[0, 999]])
  })

  it('claims nothing once the time budget is used up, and says how many schedules were left', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({
      data: [makeSchedule({ id: 's-1' }), makeSchedule({ id: 's-2' }), makeSchedule({ id: 's-3' })],
      error: null,
    })
    enqueue({ data: [{ id: 's-1' }], error: null }) // claim of s-1
    // The first run takes the function past its budget (200 s of 300 s).
    runCreates({ invoiceId: 'inv-1', invoiceNumber: null, autoSent: false, warning: null }, () => {
      vi.setSystemTime(new Date('2026-07-06T08:33:21Z'))
    })

    const { body } = await parseJsonResponse<CronBody & { not_reached: number }>(await GET(req()))

    expect(executeRecurringSchedule).toHaveBeenCalledTimes(1)
    expect(body.not_reached).toBe(2)
    expect(body.results.map((r) => r.skipReason)).toEqual([undefined, 'time_budget_reached', 'time_budget_reached'])
    // Not claimed: last_run_at of s-2 and s-3 is untouched, so the next hourly run takes them.
    const claims = updatePayloads.filter((u) => String(u.payload.last_run_warning ?? '').includes('avslutades inte'))
    expect(claims).toHaveLength(1)
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

describe('GET /api/invoices/recurring/cron: billing period', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    updatePayloads.length = 0
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances period_start by one interval after a successful run', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ interval_months: 3, period_start: '2026-07-01' })], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null }) // atomic claim
    runCreates({ invoiceId: 'inv-1', invoiceNumber: 'F-1', autoSent: true, warning: null })

    const { body } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(body.succeeded).toBe(1)
    const bump = updatePayloads.find((u) => u.table === 'recurring_invoice_schedules' && 'next_run_date' in u.payload)
    expect(bump!.payload.period_start).toBe('2026-10-01')
  })

  it('records an unnumbered draft run: last_invoice_id points at the draft so removing it can give the period back (crm#1285)', async () => {
    vi.setSystemTime(new Date('2026-10-01T08:30:00Z'))
    enqueue({
      data: [makeSchedule({ day_of_month: 1, next_run_date: '2026-10-01', period_start: '2026-10-01' })],
      error: null,
    })
    enqueue({ data: [{ id: 's-1' }], error: null }) // atomic claim
    // No auto_send: the draft is created unnumbered (numbered when issued).
    runCreates({ invoiceId: 'inv-draft', invoiceNumber: null, autoSent: false, warning: null })

    const { body } = await parseJsonResponse<CronBody>(await GET(req()))
    expect(body.succeeded).toBe(1)
    const bump = updatePayloads.find((u) => u.table === 'recurring_invoice_schedules' && 'next_run_date' in u.payload)
    expect(bump!.payload).toMatchObject({
      last_invoice_id: 'inv-draft',
      period_start: '2026-11-01',
      next_run_date: '2026-11-01',
    })
  })

  it('never writes period_start for a schedule without one', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ period_start: null })], error: null })
    enqueue({ data: [{ id: 's-1' }], error: null })
    runCreates({ invoiceId: 'inv-1', invoiceNumber: 'F-1', autoSent: true, warning: null })

    await GET(req())
    const bump = updatePayloads.find((u) => u.table === 'recurring_invoice_schedules' && 'next_run_date' in u.payload)
    expect(bump!.payload).not.toHaveProperty('period_start')
  })

  it('leaves period_start alone when a stale schedule is rolled forward without an invoice', async () => {
    vi.setSystemTime(new Date('2026-07-06T08:30:00Z'))
    enqueue({ data: [makeSchedule({ next_run_date: '2026-07-05', day_of_month: 5, period_start: '2026-07-01' })], error: null })
    enqueue({ data: null, error: null })

    await GET(req())
    expect(executeRecurringSchedule).not.toHaveBeenCalled()
    const roll = updatePayloads.find((u) => u.table === 'recurring_invoice_schedules')
    expect(roll!.payload).not.toHaveProperty('period_start')
  })
})
