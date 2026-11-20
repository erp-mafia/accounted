import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cloudBackupExtension } from '../index'
import { isScheduleDue } from '../lib/schedule'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { CloudSchedule } from '../types'
import { scheduleRecordDb } from '../lib/__tests__/schedule-record'

function findRoute(method: string, path: string) {
  const route = cloudBackupExtension.apiRoutes?.find(
    (r) => r.method === method && r.path === path
  )
  expect(route, `${method} ${path} must be registered`).toBeDefined()
  return route!
}

function makeRequest(body: unknown): Request {
  return new Request('https://test.local/api/extensions/ext/cloud-backup/schedule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * The route reads and writes an existing record through the database at its
 * version (lib/run-claim.ts); a destination with no record yet is created
 * through the settings store. `saved()` is the schedule as it ended up.
 */
function makeContext(existing: CloudSchedule | null): {
  ctx: ExtensionContext
  set: ReturnType<typeof vi.fn>
  db: ReturnType<typeof scheduleRecordDb>
  saved: () => CloudSchedule
} {
  const set = vi.fn().mockResolvedValue(undefined)
  const db = scheduleRecordDb(existing)
  const ctx = {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'cloud-backup',
    requestId: 'req_test',
    supabase: db.supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(existing),
      set,
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ExtensionContext
  const saved = () => (existing ? db.row.value : set.mock.calls[0]?.[1]) as CloudSchedule
  return { ctx, set, db, saved }
}

describe('PUT /schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears a stale hour_local on an hour_utc-only update so the UTC hour wins', async () => {
    // Existing schedule fires at 05:00 Stockholm (03:00 UTC in summer).
    const existing: CloudSchedule = {
      enabled: true,
      hour_utc: 3,
      hour_local: 5,
      last_auto_sync_at: null,
      last_auto_sync_status: null,
      last_auto_sync_error: null,
    }
    const { ctx, saved } = makeContext(existing)

    // Legacy UTC-only client moves the schedule to 14:00 UTC.
    const res = await findRoute('PUT', '/schedule').handler(
      makeRequest({ enabled: true, hour_utc: 14 }),
      ctx
    )
    expect(res.status).toBe(200)

    const stored = saved()
    expect(stored.hour_utc).toBe(14)
    // The stale local hour must not survive: the scheduler prefers
    // hour_local, so keeping 5 would make the schedule ignore 14:00 UTC.
    expect(stored.hour_local).toBeUndefined()

    // The stored schedule no longer resolves to the stale 05:00 Stockholm
    // slot (03:00 UTC in summer): not due before 14:00 UTC, due after.
    expect(isScheduleDue(stored, new Date('2026-07-12T03:30:00.000Z'))).toBe(false)
    expect(isScheduleDue(stored, new Date('2026-07-12T14:01:00.000Z'))).toBe(true)
  })

  it('stores hour_local and mirrors hour_utc on an hour_local update', async () => {
    const { ctx, set } = makeContext(null)
    const res = await findRoute('PUT', '/schedule').handler(
      makeRequest({ enabled: true, hour_local: 5 }),
      ctx
    )
    expect(res.status).toBe(200)
    const stored = set.mock.calls[0][1] as CloudSchedule
    expect(stored.hour_local).toBe(5)
    expect([3, 4]).toContain(stored.hour_utc) // CEST vs CET mirror
  })

  it('notes when automatic backup is switched on, so the card counts its two days from then', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-12T12:30:00.000Z'), toFake: ['Date'] })
    try {
      const off: CloudSchedule = {
        enabled: false,
        hour_utc: 3,
        hour_local: 5,
        last_auto_sync_at: null,
        last_auto_sync_status: null,
        last_auto_sync_error: null,
      }
      const switchedOn = makeContext(off)
      await findRoute('PUT', '/schedule').handler(makeRequest({ enabled: true, hour_local: 5 }), switchedOn.ctx)
      expect(switchedOn.saved().enabled_at).toBe('2026-07-12T12:30:00.000Z')

      // A new hour on a schedule that is already on is not a new start.
      const on = { ...off, enabled: true, enabled_at: '2026-07-01T08:00:00.000Z' }
      const moved = makeContext(on)
      await findRoute('PUT', '/schedule').handler(makeRequest({ enabled: true, hour_local: 7 }), moved.ctx)
      expect(moved.saved().enabled_at).toBe('2026-07-01T08:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('makes the member who saves the schedule its owner: the failure mail goes to them', async () => {
    const existing: CloudSchedule = {
      enabled: true,
      hour_utc: 3,
      hour_local: 5,
      last_auto_sync_at: null,
      last_auto_sync_status: null,
      last_auto_sync_error: null,
    }
    const { ctx, db } = makeContext(existing)
    expect(db.row.user_id).toBe('owner-before')

    const res = await findRoute('PUT', '/schedule').handler(makeRequest({ enabled: true, hour_local: 7 }), ctx)

    expect(res.status).toBe(200)
    expect(db.row.user_id).toBe('user-1')
  })

  describe('while a backup run writes the same record', () => {
    const base: CloudSchedule = {
      enabled: true,
      hour_utc: 3,
      hour_local: 5,
      last_auto_sync_at: '2026-07-11T03:05:00.000Z',
      last_auto_sync_status: 'success',
      last_auto_sync_error: null,
      consecutive_failures: 0,
    }

    it('keeps a claim a run took between the edit\'s read and its write: no second run can start beside it', async () => {
      const { ctx, db } = makeContext(base)
      db.hooks.afterRead = () => {
        db.hooks.afterRead = null
        db.writeElsewhere({ sync_started_at: '2026-07-12T12:00:00.000Z', sync_started_by: 'cron' })
      }

      const res = await findRoute('PUT', '/schedule').handler(makeRequest({ enabled: true, hour_local: 7 }), ctx)

      expect(res.status).toBe(200)
      expect(db.row.value).toMatchObject({
        hour_local: 7,
        sync_started_at: '2026-07-12T12:00:00.000Z',
        sync_started_by: 'cron',
      })
    })

    it('does not bring back a claim its run released in between, and keeps the run\'s outcome', async () => {
      const { ctx, db } = makeContext({ ...base, sync_started_at: '2026-07-12T12:00:00.000Z', sync_started_by: 'cron' })
      db.hooks.afterRead = () => {
        db.hooks.afterRead = null
        db.writeElsewhere({
          sync_started_at: null,
          sync_started_by: null,
          last_auto_sync_at: '2026-07-12T12:01:30.000Z',
          last_auto_sync_status: 'error',
          last_auto_sync_error: 'Något gick fel. Försök igen.',
          consecutive_failures: 1,
        })
      }

      const res = await findRoute('PUT', '/schedule').handler(makeRequest({ enabled: true, hour_local: 7 }), ctx)

      expect(res.status).toBe(200)
      expect(db.row.value).toMatchObject({
        hour_local: 7,
        sync_started_at: null,
        last_auto_sync_status: 'error',
        consecutive_failures: 1,
      })
      expect((await res.json()).data).toMatchObject({ hour_local: 7, sync_started_at: null })
    })

    it('answers a conflict, and writes nothing, when the destination was disconnected meanwhile', async () => {
      const { ctx, db, set } = makeContext(base)
      db.hooks.afterRead = () => {
        db.hooks.afterRead = null
        db.remove()
      }

      const res = await findRoute('PUT', '/schedule').handler(makeRequest({ enabled: true, hour_local: 7 }), ctx)

      expect(res.status).toBe(409)
      expect(db.row.value).toBeNull()
      expect(set).not.toHaveBeenCalled()
    })
  })

  it('rejects a request without a valid hour', async () => {
    const { ctx, set } = makeContext(null)
    const res = await findRoute('PUT', '/schedule').handler(
      makeRequest({ enabled: true }),
      ctx
    )
    expect(res.status).toBe(400)
    expect(set).not.toHaveBeenCalled()
  })
})
