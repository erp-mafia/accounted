import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { logError, logWarn } = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: logWarn, error: logError, child: (): unknown => logger }
  return { ...actual, createLogger: () => logger }
})

import {
  patchScheduleRow,
  readScheduleRow,
  withManualRunClaim,
  writeScheduleAtVersion,
} from '../run-claim'
import type { CloudSchedule } from '../../types'
import { scheduleRecordDb } from './schedule-record'

/**
 * The run claim: one backup run per company and destination, and every write
 * of the schedule record built on the record as it is. Two runs on one
 * destination uploaded the same archives twice (a first Google Drive upload
 * has no file id, so the folder got two files of the same name), and a write
 * of a copy read earlier put back what another run, or the person, had
 * written since.
 */

const NOW = new Date('2026-07-12T12:30:00.000Z')
const key = { companyId: 'c-1', scheduleKey: 'google_drive_schedule' }

const schedule = (overrides: Partial<CloudSchedule> = {}): CloudSchedule => ({
  enabled: true,
  hour_utc: 3,
  last_auto_sync_at: null,
  last_auto_sync_status: null,
  last_auto_sync_error: null,
  ...overrides,
})

const database = scheduleRecordDb

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('readScheduleRow / writeScheduleAtVersion', () => {
  it('reads the record with its version, for this company, extension and key only', async () => {
    const db = database(schedule())
    const row = await readScheduleRow(db.supabase, key)
    expect(row).toEqual({ value: schedule(), version: db.row.updated_at })
    expect(db.mock.findCalls('extension_data', 'eq')).toEqual([
      ['company_id', 'c-1'],
      ['extension_id', 'cloud-backup'],
      ['key', 'google_drive_schedule'],
    ])
  })

  it('throws when the record cannot be read, instead of reading that as no record', async () => {
    const db = database(schedule(), { failRead: true })
    await expect(readScheduleRow(db.supabase, key)).rejects.toThrow('connection reset')
  })

  it('writes at the version read and answers the new one', async () => {
    const db = database(schedule())
    const { version } = (await readScheduleRow(db.supabase, key))!
    const next = schedule({ sync_started_at: NOW.toISOString(), sync_started_by: 'cron' })

    const written = await writeScheduleAtVersion(db.supabase, key, version, next)

    expect(written).toBe(db.row.updated_at)
    expect(written).not.toBe(version)
    expect(db.row.value).toEqual(next)
    expect(db.mock.findCalls('extension_data', 'eq')).toContainEqual(['updated_at', version])
  })

  it('writes nothing once someone else has written the record: a released claim is not a licence to write an old copy back', async () => {
    const db = database(schedule())
    const { version, value } = (await readScheduleRow(db.supabase, key))!
    // Another delivery ran the company and released its claim since.
    db.writeElsewhere({ last_auto_sync_at: NOW.toISOString(), last_auto_sync_status: 'error', consecutive_failures: 3 })

    const written = await writeScheduleAtVersion(db.supabase, key, version, { ...value, sync_started_at: NOW.toISOString() })

    expect(written).toBeNull()
    expect(db.row.value).toMatchObject({ last_auto_sync_status: 'error', consecutive_failures: 3 })
    expect(db.row.value).not.toHaveProperty('sync_started_at')
  })
})

describe('patchScheduleRow', () => {
  it('writes the patch on the version the caller holds when nothing changed', async () => {
    const db = database(schedule())
    const known = (await readScheduleRow(db.supabase, key))!

    const outcome = await patchScheduleRow(db.supabase, key, known, (current) => ({ ...current, consecutive_failures: 1 }))

    expect(outcome).toBe('written')
    expect(db.row.value).toMatchObject({ consecutive_failures: 1 })
    // No second read was needed.
    expect(db.mock.findCalls('extension_data', 'update')).toHaveLength(1)
    expect(db.mock.findCalls('extension_data', 'select').filter(([columns]) => columns === 'value, updated_at')).toHaveLength(1)
  })

  it('reads the record again when someone wrote in between, and patches that', async () => {
    const db = database(schedule({ hour_local: 5 }))
    const known = (await readScheduleRow(db.supabase, key))!
    db.writeElsewhere({ hour_local: 22, enabled: false })

    const outcome = await patchScheduleRow(db.supabase, key, known, (current) => ({
      ...current,
      last_auto_sync_status: 'success',
    }))

    expect(outcome).toBe('written')
    expect(db.row.value).toMatchObject({ hour_local: 22, enabled: false, last_auto_sync_status: 'success' })
  })

  it('leaves the record alone when the patch declines the record as it is now', async () => {
    const db = database(schedule({ sync_started_at: '2026-07-12T12:00:00.000Z' }))
    const known = (await readScheduleRow(db.supabase, key))!
    db.writeElsewhere({ sync_started_at: '2026-07-12T12:20:00.000Z' })

    const outcome = await patchScheduleRow(db.supabase, key, known, (current) =>
      current.sync_started_at === '2026-07-12T12:00:00.000Z' ? { ...current, sync_started_at: null } : null
    )

    expect(outcome).toBe('left')
    expect(db.row.value?.sync_started_at).toBe('2026-07-12T12:20:00.000Z')
  })

  it('answers gone when the record was removed meanwhile, not lost', async () => {
    const db = database(schedule())
    const known = (await readScheduleRow(db.supabase, key))!
    db.remove()

    expect(await patchScheduleRow(db.supabase, key, known, (current) => ({ ...current, consecutive_failures: 1 }))).toBe('gone')
  })

  it('answers lost when every try loses to another writer', async () => {
    const db = database(schedule())
    const known = (await readScheduleRow(db.supabase, key))!

    const outcome = await patchScheduleRow(db.supabase, key, known, (current) => {
      // Someone writes again after each of our reads.
      db.writeElsewhere({ hour_local: (current.hour_local ?? 0) + 1 })
      return { ...current, consecutive_failures: 9 }
    })

    expect(outcome).toBe('lost')
    expect(db.row.value).not.toHaveProperty('consecutive_failures')
  })
})

describe('withManualRunClaim', () => {
  it('claims as a manual run, runs the sync and releases the claim on the schedule as it is then', async () => {
    const db = database(schedule({ consecutive_failures: 1, hour_local: 5 }))
    const sync = vi.fn(async () => {
      expect(db.row.value).toMatchObject({ sync_started_at: NOW.toISOString(), sync_started_by: 'manual' })
      // The person changes the hour while the backup runs.
      db.writeElsewhere({ hour_local: 7 })
      return 'done'
    })

    await expect(withManualRunClaim(db.supabase, key, sync)).resolves.toEqual({ busy: false, result: 'done' })

    expect(db.row.value).toMatchObject({
      sync_started_at: null,
      sync_started_by: null,
      consecutive_failures: 1,
      hour_local: 7,
    })
    expect(logError).not.toHaveBeenCalled()
  })

  it('answers busy, and does not sync, while the nightly run holds the destination', async () => {
    const db = database(schedule({ sync_started_at: '2026-07-12T12:28:00.000Z', sync_started_by: 'cron' }))
    const sync = vi.fn()

    await expect(withManualRunClaim(db.supabase, key, sync)).resolves.toEqual({ busy: true })

    expect(sync).not.toHaveBeenCalled()
    expect(db.mock.findCalls('extension_data', 'update')).toEqual([])
  })

  it('answers busy when another run writes the record between the read and the claim', async () => {
    const db = database(schedule())
    // The cron claims right after this run's read.
    db.hooks.afterRead = () => {
      db.hooks.afterRead = null
      db.writeElsewhere({ sync_started_at: NOW.toISOString(), sync_started_by: 'cron' })
    }
    const sync = vi.fn()

    await expect(withManualRunClaim(db.supabase, key, sync)).resolves.toEqual({ busy: true })
    expect(sync).not.toHaveBeenCalled()
    expect(db.row.value).toMatchObject({ sync_started_by: 'cron' })
  })

  it('releases the claim when the sync throws', async () => {
    const db = database(schedule())

    await expect(
      withManualRunClaim(db.supabase, key, async () => {
        throw new Error('Drive quota exceeded')
      })
    ).rejects.toThrow('Drive quota exceeded')

    expect(db.row.value?.sync_started_at).toBeNull()
  })

  it('says so when the release does not land: the destination would look busy for no reason', async () => {
    const db = database(schedule())

    await withManualRunClaim(db.supabase, key, async () => {
      // Someone writes the record again after every read of the release.
      db.hooks.afterRead = () => db.writeElsewhere({ hour_local: (db.row.value?.hour_local ?? 0) + 1 })
      db.writeElsewhere({ hour_local: 1 })
      return 'done'
    })

    expect(logError).toHaveBeenCalledWith(
      'backup run claim not released: the schedule record kept changing',
      undefined,
      key
    )
  })

  it('only warns when the destination was disconnected during the run: there is no claim left to release', async () => {
    const db = database(schedule())

    await withManualRunClaim(db.supabase, key, async () => {
      db.remove()
      return 'done'
    })

    expect(logError).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('backup run claim not released: the schedule record was removed', key)
  })

  it('just runs for a destination with no schedule record to claim on', async () => {
    const db = database(null)
    await expect(withManualRunClaim(db.supabase, key, async () => 'done')).resolves.toEqual({
      busy: false,
      result: 'done',
    })
    expect(db.mock.findCalls('extension_data', 'update')).toEqual([])
  })

  it('self-hosted, takes a manual run of several hours as still running: there is no time limit to end it', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const db = database(schedule({ sync_started_at: '2026-07-12T09:30:00.000Z', sync_started_by: 'manual' }))
    const sync = vi.fn()

    await expect(withManualRunClaim(db.supabase, key, sync)).resolves.toEqual({ busy: true })
    expect(sync).not.toHaveBeenCalled()
  })
})
