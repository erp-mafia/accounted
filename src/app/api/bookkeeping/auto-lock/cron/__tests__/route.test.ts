/**
 * The nightly automatic lock: "Automatisk låsning efter"
 * (company_settings.auto_lock_period_days) was stored and nothing acted on
 * it. The job moves a lock date behind the floor up to it, through the real
 * settings service, so the cases below also pin what the service is asked
 * for: a save that replaces only the lock date the job read, and that names
 * the job, never a person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest, createQueuedMockSupabase, manyRows, POSTGREST_MAX_ROWS } from '@/tests/helpers'

const db = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: () => db.client }))

import { getErrorEntry } from '@/lib/errors/structured-errors'
import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { GET } from '../route'

const PATH = '/api/bookkeeping/auto-lock/cron'
const NIGHT = new Date('2026-11-17T01:40:00Z')
const CREATOR = '00000000-0000-4000-8000-0000000000aa'
const HAS_DEADLINES = { data: null, count: 5 }

type LockEvent = EventPayload<'period.lock_date_changed'>

/** A row of the job's list: a live company with the setting on. */
function listed(companyId: string, days: number, lockedThrough: string | null) {
  return {
    company_id: companyId,
    auto_lock_period_days: days,
    bookkeeping_locked_through: lockedThrough,
    companies: { archived_at: null, created_by: CREATOR },
  }
}

/** The stored settings row the service reads before it writes. */
function stored(companyId: string, lockedThrough: string | null) {
  return { id: `cs-${companyId}`, company_id: companyId, bookkeeping_locked_through: lockedThrough }
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let emitted: LockEvent[]

/** One company the service moves: its stored row, the update's answer, the deadline count. */
function enqueueMove(companyId: string, before: string | null, after: string) {
  mock.enqueue({ data: stored(companyId, before) })
  mock.enqueue({ data: stored(companyId, after) })
  mock.enqueue(HAS_DEADLINES)
}

async function run() {
  const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
  return { status: response.status, body: (await response.json()) as { data: Record<string, unknown> } }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NIGHT)
  vi.stubEnv('CRON_SECRET', 'cron-secret')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role')
  mock = createQueuedMockSupabase()
  db.client = mock.supabase
  emitted = []
  eventBus.on('period.lock_date_changed', (payload) => {
    emitted.push(payload)
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/bookkeeping/auto-lock/cron', () => {
  it('returns 401 without the cron secret', async () => {
    const response = await GET(createCronRequest(PATH, 'Bearer wrong'))
    expect(response.status).toBe(401)
  })

  it('moves a missing or earlier lock date to the floor and leaves one at or past it alone', async () => {
    mock.enqueue({
      data: [
        listed('co-none', 30, null),
        listed('co-early', 90, '2024-12-31'),
        // Where last night's run left it: a second run writes nothing.
        listed('co-at-floor', 30, '2026-09-30'),
        listed('co-past', 60, '2026-10-31'),
      ],
    })
    enqueueMove('co-none', null, '2026-09-30')
    enqueueMove('co-early', '2024-12-31', '2026-07-31')

    const { status, body } = await run()

    expect(status).toBe(200)
    expect(body.data).toEqual({
      date: '2026-11-17',
      companies_with_auto_lock: 4,
      moved: 2,
      changed_meanwhile: 0,
      not_reached: 0,
      failed: 0,
      failures: [],
    })
    // Only the lock date is written, for the two companies behind their floor.
    expect(mock.findCalls('company_settings', 'update')).toEqual([
      [{ bookkeeping_locked_through: '2026-09-30' }],
      [{ bookkeeping_locked_through: '2026-07-31' }],
    ])
  })

  it('reads live companies with the setting on, in a stable order', async () => {
    mock.enqueue({ data: [] })

    await run()

    expect(mock.findCall('company_settings', 'not')).toEqual(['auto_lock_period_days', 'is', null])
    expect(mock.findCall('company_settings', 'is')).toEqual(['companies.archived_at', null])
    expect(mock.findCall('company_settings', 'order')).toEqual(['company_id', { ascending: true }])
  })

  it('fires period.lock_date_changed as the automatic lock, forward, filed under the company creator', async () => {
    mock.enqueue({ data: [listed('co-early', 30, '2025-12-31')] })
    enqueueMove('co-early', '2025-12-31', '2026-09-30')

    await run()

    expect(emitted).toEqual([
      {
        previousLockDate: '2025-12-31',
        lockDate: '2026-09-30',
        direction: 'forward',
        via: 'auto_lock',
        reopenedFiledVatPeriods: [],
        userId: CREATOR,
        companyId: 'co-early',
      },
    ])
  })

  it('never moves back a lock date somebody saved after the list was read, and sends no event for it', async () => {
    mock.enqueue({ data: [listed('co-moved', 30, null), listed('co-raced', 30, null), listed('co-next', 30, null)] })
    // Somebody locked through October before the job reached the company.
    mock.enqueue({ data: stored('co-moved', '2026-10-31') })
    // The update's condition matched no row: the date changed between the service's read and its write.
    mock.enqueue({ data: stored('co-raced', null) })
    mock.enqueue({ data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } })
    enqueueMove('co-next', null, '2026-09-30')

    const { status, body } = await run()

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ moved: 1, changed_meanwhile: 2, failed: 0 })
    expect(emitted.map((event) => event.companyId)).toEqual(['co-next'])
    // The company locked through October was never written to.
    expect(mock.findCalls('company_settings', 'update')).toHaveLength(2)
  })

  it('counts a company that fails, with its reason, and goes on with the rest', async () => {
    mock.enqueue({ data: [listed('co-held', 30, null), listed('co-refused', 30, null), listed('co-next', 90, null)] })
    // The database refuses to lock more while an SIE import holds a period.
    mock.enqueue({ data: stored('co-held', null) })
    mock.enqueue({
      data: null,
      error: { code: '55000', message: 'SIE_IMPORT_HOLD: importen måste slutföras innan bokföringen låses' },
    })
    // The service refuses every save of a row whose stored reminder levels are out of order.
    mock.enqueue({ data: { ...stored('co-refused', null), reminder_days_level_1: 30, reminder_days_level_2: 15 } })
    enqueueMove('co-next', null, '2026-07-31')

    const { status, body } = await run()

    const refusal = getErrorEntry('SETTINGS_REMINDER_DAYS_ORDER')?.message_sv
    expect(refusal).toEqual(expect.any(String))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      moved: 1,
      failed: 2,
      failures: [
        {
          company_id: 'co-held',
          error: 'Lock date not moved: SIE_IMPORT_HOLD: importen måste slutföras innan bokföringen låses',
        },
        { company_id: 'co-refused', error: refusal },
      ],
    })
    expect(emitted.map((event) => event.companyId)).toEqual(['co-next'])
  })

  it('is not stopped by a company whose setting holds an absurd number of days', async () => {
    // The column takes any integer; this one is no date any number of days back.
    mock.enqueue({ data: [listed('co-absurd', 2_147_483_647, null), listed('co-next', 30, null)] })
    enqueueMove('co-next', null, '2026-09-30')

    const { status, body } = await run()

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ companies_with_auto_lock: 2, moved: 1, failed: 0 })
    expect(mock.findCalls('company_settings', 'update')).toEqual([[{ bookkeeping_locked_through: '2026-09-30' }]])
  })

  it('pages past the 1000-row cap so no company is left out', async () => {
    mock.enqueue({ data: manyRows(POSTGREST_MAX_ROWS, (i) => listed(`co-${i}`, 30, '2026-09-30')) })
    mock.enqueue({ data: [listed('co-last', 30, null)] })
    enqueueMove('co-last', null, '2026-09-30')

    const { body } = await run()

    expect(mock.findCalls('company_settings', 'range')).toEqual([[0, 999], [1000, 1999]])
    expect(body.data).toMatchObject({ companies_with_auto_lock: 1001, moved: 1 })
  })

  it('starts no company past its time budget and says how many are left', async () => {
    mock.enqueue({ data: [listed('co-first', 30, null), listed('co-second', 30, null), listed('co-third', 30, null)] })
    enqueueMove('co-first', null, '2026-09-30')
    // The first company's move takes the run past its budget.
    eventBus.on('period.lock_date_changed', () => {
      vi.setSystemTime(new Date(NIGHT.getTime() + 241_000))
    })

    const { status, body } = await run()

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ moved: 1, not_reached: 2, failed: 0 })
    expect(mock.findCalls('company_settings', 'update')).toHaveLength(1)
  })

  it('answers an error when the companies cannot be read', async () => {
    mock.enqueue({ error: { message: 'canceling statement due to statement timeout' } })

    const { status } = await run()

    expect(status).toBeGreaterThanOrEqual(500)
    expect(mock.findCalls('company_settings', 'update')).toHaveLength(0)
  })
})
