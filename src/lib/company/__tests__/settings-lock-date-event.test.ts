/**
 * period.lock_date_changed (issue #128): updateCompanySettings emits it,
 * awaited, after a save that really moved the stored lock date
 * (company_settings.bookkeeping_locked_through), on every door: the settings
 * page ('app'), a direct v1 call ('api') and the approval of a staged change
 * ('approval'). The filed momsdeklaration periods a backward move reopens are
 * worked out in the service, so every door names them. The webhook payload
 * carries the door, never the person: the internal userId is stripped on
 * delivery like on every other event.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatFilingRecord } from '@/lib/vat/filing-record'
import { createQueuedMockSupabase } from '@/tests/helpers'

const listVatFilings = vi.hoisted(() => vi.fn<() => Promise<VatFilingRecord[]>>(async () => []))
vi.mock('@/lib/vat/filing-record-store', () => ({ listVatFilings: () => listVatFilings() }))

// The webhook fan-out's own service-role client and its dispatch kick.
const fanOutClient = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return { ...actual, createServiceClientNoCookies: vi.fn(() => fanOutClient.current) }
})
vi.mock('@/lib/webhooks/dispatch-kick', () => ({ kickWebhookDispatch: vi.fn() }))

import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { createLogger } from '@/lib/logger'
import { fanOutEvent } from '@/lib/webhooks/handler'
import { PUBLIC_WEBHOOK_EVENTS } from '@/lib/webhooks/public-events'
import { settingsUpdateBookkeepingLock } from '@/lib/operations/company-settings'
import { filedVatPeriodsReopenedBy } from '@/lib/vat/filed-periods-reopened'
import { updateCompanySettings, type UpdateCompanySettingsOptions } from '../settings-service'

const COMPANY = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-0000000000aa'
const STORED = {
  id: 'cs-1',
  company_id: COMPANY,
  entity_type: 'aktiebolag',
  company_name: 'Test AB',
  bookkeeping_locked_through: '2026-06-30' as string | null,
  reminder_days_level_1: 15,
  reminder_days_level_2: 30,
  reminder_days_level_3: 45,
}
const HAS_DEADLINES = { data: null, count: 5 }

/** A filed 2026 Q2 momsdeklaration (april to june, filed in august). */
const FILED_Q2: VatFilingRecord = {
  deadline_id: 'dl-q2',
  period_type: 'quarterly',
  year: 2026,
  period: 2,
  tax_period: '2026-Q2',
  period_start: '2026-04-01',
  period_end: '2026-06-30',
  filed_on: '2026-08-12',
  source: 'manual',
  reference: null,
}

type LockEvent = EventPayload<'period.lock_date_changed'>

let emitted: LockEvent[]

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  listVatFilings.mockResolvedValue([])
  emitted = []
  eventBus.on('period.lock_date_changed', (payload) => {
    emitted.push(payload)
  })
})

/**
 * One settings save through the service on a queued client: the stored row
 * is read, then (unless dry run) updated to `storedAfter`.
 */
async function save(
  before: string | null,
  body: Record<string, unknown>,
  options: Partial<UpdateCompanySettingsOptions> = {},
  storedAfter: { data?: unknown; error?: unknown } = {
    data: { ...STORED, bookkeeping_locked_through: 'bookkeeping_locked_through' in body ? body.bookkeeping_locked_through : before },
  },
) {
  const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
  enqueue({ data: { ...STORED, bookkeeping_locked_through: before } }) // the stored row
  if (!options.dryRun) enqueue(storedAfter) // update ... returning
  enqueue(HAS_DEADLINES) // system deadlines exist: no self-heal
  const outcome = await updateCompanySettings(
    { supabase: supabase as never, companyId: COMPANY, userId: USER, log: createLogger('test') },
    body,
    { adminVerified: true, via: 'app', findReopenedFiledVatPeriods: filedVatPeriodsReopenedBy, ...options },
  )
  return { outcome, updates: findCalls('company_settings', 'update') }
}

describe('period.lock_date_changed: when it fires', () => {
  it('is in the public webhook catalogue (and so the docs, OpenAPI and the event feed)', () => {
    expect(PUBLIC_WEBHOOK_EVENTS).toContain('period.lock_date_changed')
  })

  it('fires forward when a first lock date is set', async () => {
    const { outcome } = await save(null, { bookkeeping_locked_through: '2026-09-30' })
    expect(outcome.ok).toBe(true)
    expect(emitted).toEqual([
      {
        previousLockDate: null,
        lockDate: '2026-09-30',
        direction: 'forward',
        via: 'app',
        reopenedFiledVatPeriods: [],
        userId: USER,
        companyId: COMPANY,
      },
    ])
    expect(listVatFilings).not.toHaveBeenCalled()
  })

  it('fires forward when the lock date moves later (the monthly close)', async () => {
    await save('2026-06-30', { bookkeeping_locked_through: '2026-07-31' })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ previousLockDate: '2026-06-30', lockDate: '2026-07-31', direction: 'forward' })
    expect(emitted[0].reopenedFiledVatPeriods).toEqual([])
  })

  it('fires backward when the lock date moves earlier, naming the filed periods it reopened', async () => {
    listVatFilings.mockResolvedValue([FILED_Q2])
    const { outcome } = await save('2026-06-30', { bookkeeping_locked_through: '2026-04-30' })
    expect(outcome.ok).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ previousLockDate: '2026-06-30', lockDate: '2026-04-30', direction: 'backward' })
    expect(emitted[0].reopenedFiledVatPeriods).toEqual([
      { tax_period: '2026-Q2', period_start: '2026-04-01', period_end: '2026-06-30', filed_on: '2026-08-12' },
    ])
    // An acknowledged move (no door refuses it here): the save goes
    // through and the warnings say what was reopened.
    if (outcome.ok && !outcome.dryRun) {
      expect(outcome.warnings?.map((w) => w.code)).toEqual([
        'BOOKKEEPING_LOCK_MOVED_BACKWARDS',
        'BOOKKEEPING_LOCK_REOPENED_FILED_VAT',
      ])
    }
  })

  it('fires backward with a null lockDate when the lock is removed', async () => {
    listVatFilings.mockResolvedValue([FILED_Q2])
    await save('2026-06-30', { bookkeeping_locked_through: null })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ previousLockDate: '2026-06-30', lockDate: null, direction: 'backward' })
    expect(emitted[0].reopenedFiledVatPeriods.map((p) => p.tax_period)).toEqual(['2026-Q2'])
  })

  it('stays silent when the save resends the stored date (every settings page save does)', async () => {
    const { outcome, updates } = await save('2026-06-30', { bookkeeping_locked_through: '2026-06-30', company_name: 'Test AB' })
    expect(outcome.ok).toBe(true)
    expect(updates).toHaveLength(1)
    expect(emitted).toEqual([])
    // No move back, so the filed periods are not read and cannot fail the save.
    expect(listVatFilings).not.toHaveBeenCalled()
  })

  it('stays silent when the save does not touch the lock date', async () => {
    await save('2026-06-30', { company_name: 'Test AB' }, {}, { data: { ...STORED, bookkeeping_locked_through: null } })
    expect(emitted).toEqual([])
  })

  it('stays silent on a dry run, which writes nothing', async () => {
    const { outcome, updates } = await save('2026-06-30', { bookkeeping_locked_through: '2026-07-31' }, { dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    expect(updates).toHaveLength(0)
    expect(emitted).toEqual([])
  })

  it('stays silent when the update fails (a lock the database refuses included)', async () => {
    const { outcome } = await save(
      '2026-06-30',
      { bookkeeping_locked_through: '2026-07-31' },
      {},
      { data: null, error: { code: 'P0001', message: 'refused' } },
    )
    expect(outcome.ok).toBe(false)
    expect(emitted).toEqual([])
  })

  it('stays silent and fails closed when the filed periods cannot be read', async () => {
    listVatFilings.mockRejectedValue(new Error('deadlines unreadable'))
    const { outcome, updates } = await save('2026-06-30', { bookkeeping_locked_through: '2026-04-30' })
    expect(outcome).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR' })
    expect(updates).toHaveLength(0)
    expect(emitted).toEqual([])
  })

  it('refuses a door that asks before reopening a filed period, and stays silent', async () => {
    listVatFilings.mockResolvedValue([FILED_Q2])
    const { outcome, updates } = await save(
      '2026-06-30',
      { bookkeeping_locked_through: '2026-04-30' },
      { refuseReopeningFiledVat: true, via: 'api' },
    )
    expect(outcome).toMatchObject({
      ok: false,
      code: 'BOOKKEEPING_LOCK_REOPENS_FILED_VAT',
      details: { filed_periods: [expect.objectContaining({ tax_period: '2026-Q2' })] },
    })
    expect(updates).toHaveLength(0)
    expect(emitted).toEqual([])
  })
})

describe('period.lock_date_changed: via names the door', () => {
  /** The v1 and MCP lock operation, as a direct call or as an approved staged change. */
  async function runLockOperation(pendingOperationId?: string) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: STORED }) // the stored row
    enqueue({ data: { role: 'owner' } }) // the API-key and MCP doors read the role
    enqueue({ data: { ...STORED, bookkeeping_locked_through: '2026-07-31' } }) // update ... returning
    enqueue(HAS_DEADLINES)
    return settingsUpdateBookkeepingLock.run(
      {
        supabase: supabase as never,
        companyId: COMPANY,
        userId: USER,
        log: createLogger('test'),
        ...(pendingOperationId ? { pendingOperationId } : {}),
      },
      { bookkeeping_locked_through: '2026-07-31' },
      { dryRun: false },
    )
  }

  it("is 'api' for a direct v1 call", async () => {
    expect((await runLockOperation()).ok).toBe(true)
    expect(emitted.map((e) => e.via)).toEqual(['api'])
  })

  it("is 'approval' when a staged change (MCP or ?stage=true) is approved", async () => {
    expect((await runLockOperation('op-1')).ok).toBe(true)
    expect(emitted.map((e) => e.via)).toEqual(['approval'])
  })

  it('keeps the dry run of an acknowledged move naming the reopened periods, and emits nothing', async () => {
    listVatFilings.mockResolvedValue([FILED_Q2])
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: STORED })
    enqueue({ data: { role: 'owner' } })
    enqueue(HAS_DEADLINES)
    const outcome = await settingsUpdateBookkeepingLock.run(
      { supabase: supabase as never, companyId: COMPANY, userId: USER, log: createLogger('test') },
      { bookkeeping_locked_through: '2026-04-30', acknowledge_filed_vat_periods: true },
      { dryRun: true },
    )
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (outcome.ok && outcome.dryRun) {
      expect(outcome.preview.reopened_filed_vat_periods).toContain('2026-Q2')
    }
    expect(emitted).toEqual([])
  })

  it("is what the settings page passes ('app')", async () => {
    await save(null, { bookkeeping_locked_through: '2026-09-30' }, { via: 'app' })
    expect(emitted.map((e) => e.via)).toEqual(['app'])
  })
})

describe('period.lock_date_changed: the delivered payload', () => {
  it('carries the door and the dates, never the user id', async () => {
    listVatFilings.mockResolvedValue([FILED_Q2])
    await save('2026-06-30', { bookkeeping_locked_through: null })
    expect(emitted).toHaveLength(1)

    const insert = vi.fn(async (_rows: unknown) => ({ error: null }))
    const lookup = {
      select: () => lookup,
      eq: () => lookup,
      contains: () => lookup,
      is: async () => ({
        data: [{ id: 'wh-1', api_version_pinned: '2026-05-12', verified_at: '2026-10-01T00:00:00Z', verification_grace_ends_at: null }],
        error: null,
      }),
    }
    fanOutClient.current = { from: (table: string) => (table === 'webhooks' ? lookup : { insert }) } as unknown as SupabaseClient

    await fanOutEvent('period.lock_date_changed', emitted[0])

    const rows = insert.mock.calls[0]?.[0] as Array<{ event_type: string; payload: Record<string, unknown> }>
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('period.lock_date_changed')
    expect(rows[0].payload).toEqual({
      previousLockDate: '2026-06-30',
      lockDate: null,
      direction: 'backward',
      via: 'app',
      reopenedFiledVatPeriods: [
        { tax_period: '2026-Q2', period_start: '2026-04-01', period_end: '2026-06-30', filed_on: '2026-08-12' },
      ],
      companyId: COMPANY,
    })
    expect(JSON.stringify(rows[0].payload)).not.toContain(USER)
  })
})
