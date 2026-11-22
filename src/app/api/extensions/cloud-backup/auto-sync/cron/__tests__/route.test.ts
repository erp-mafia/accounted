/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/extensions/general/cloud-backup/lib/sync', () => ({
  performSync: vi.fn(),
  CONNECTION_KEY: 'google_drive_connection',
  SCHEDULE_KEY: 'google_drive_schedule',
  saveExtensionData: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/extensions/general/cloud-backup/lib/backup-alert', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/extensions/general/cloud-backup/lib/backup-alert')>()
  return {
    ...actual,
    sendBackupFailureAlert: vi.fn().mockResolvedValue({ sent: true }),
  }
})

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn().mockReturnValue(null),
}))

// The schedule records as the database holds them: a value and a row version
// that every write moves. The real compare-and-set against PostgREST is
// pinned in lib/__tests__/run-claim.test.ts; this keeps its contract (a write
// lands only on the version read, a patch is built on the record as it is)
// so the route's reads and writes can be played against a record that
// changes while the run is under way.
const records = vi.hoisted(() => {
  const rows = new Map<string, { value: any; version: string }>()
  const writes: { companyId: string; scheduleKey: string; kind: 'versioned' | 'patch'; value: any }[] = []
  let serial = 0
  const id = (key: { companyId: string; scheduleKey: string }) => `${key.companyId}:${key.scheduleKey}`
  const put = (key: { companyId: string; scheduleKey: string }, value: any) => {
    const version = `v${++serial}`
    rows.set(id(key), { value, version })
    return version
  }
  return { rows, writes, id, put }
})
vi.mock('@/extensions/general/cloud-backup/lib/run-claim', () => ({
  readScheduleRow: vi.fn(async (_supabase: unknown, key: any) => {
    const row = records.rows.get(records.id(key))
    return row ? { value: { ...row.value }, version: row.version } : null
  }),
  writeScheduleAtVersion: vi.fn(async (_supabase: unknown, key: any, version: string, value: any) => {
    if (records.rows.get(records.id(key))?.version !== version) return null
    records.writes.push({ ...key, kind: 'versioned', value })
    return records.put(key, value)
  }),
  patchScheduleRow: vi.fn(async (_supabase: unknown, key: any, _known: unknown, patch: (v: any) => any) => {
    const row = records.rows.get(records.id(key))
    if (!row) return 'lost'
    const next = patch(row.value)
    if (!next) return 'left'
    records.writes.push({ ...key, kind: 'patch', value: next })
    records.put(key, next)
    return 'written'
  }),
}))

const { logError, logWarn } = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: logWarn, error: logError, child: (): unknown => logger }
  return { ...actual, createLogger: () => logger }
})

import { GET } from '../route'
import { createClient } from '@supabase/supabase-js'
import { performSync } from '@/extensions/general/cloud-backup/lib/sync'
import { sendBackupFailureAlert } from '@/extensions/general/cloud-backup/lib/backup-alert'
import { patchScheduleRow, writeScheduleAtVersion } from '@/extensions/general/cloud-backup/lib/run-claim'
import { verifyCronSecret } from '@/lib/auth/cron'

const mockCreateClient = vi.mocked(createClient)
const mockPerformSync = vi.mocked(performSync)
const mockSendBackupFailureAlert = vi.mocked(sendBackupFailureAlert)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockVersionedWrite = vi.mocked(writeScheduleAtVersion)
const mockPatch = vi.mocked(patchScheduleRow)

const recordKey = (companyId = 'c-1', scheduleKey = 'google_drive_schedule') => ({ companyId, scheduleKey })
/** The record as stored now. */
const stored = (companyId?: string, scheduleKey?: string) =>
  records.rows.get(records.id(recordKey(companyId, scheduleKey)))!.value
/** What the runs recorded once a company's turn was over (alert state, deferral, outcome). */
const outcomes = () => records.writes.filter((write) => write.kind === 'patch')
/** The claims taken, and the left-over counts: writes at a version. */
const versioned = () => records.writes.filter((write) => write.kind === 'versioned')
/** Someone else (another delivery of the cron, the person) writes the record after the run read its rows. */
const writeElsewhere = (change: Record<string, unknown>, companyId?: string) =>
  records.put(recordKey(companyId), { ...stored(companyId), ...change })

// All tests run at a frozen 2026-07-12 12:30 UTC.
const NOW = new Date('2026-07-12T12:30:00.000Z')

function makeRequest() {
  return new Request('http://localhost/api/extensions/cloud-backup/auto-sync/cron', {
    headers: { authorization: 'Bearer test-secret' },
  })
}

/**
 * The route issues two list queries against extension_data: every provider's
 * schedule keys, then the matching connection keys. Both use `.in('key', ...)`,
 * so route rows to the right result by inspecting the key list. The schedule
 * rows are also stored as the records the run then reads and writes one by
 * one, at the version the list answers.
 */
function makeSupabaseStub(
  scheduleRows: unknown[],
  options: {
    scheduleError?: unknown
    connectionRows?: unknown[]
    connectionError?: unknown
  } = {}
) {
  const listed = (scheduleRows as any[]).map((row) => ({
    ...row,
    updated_at: records.put({ companyId: row.company_id, scheduleKey: row.key }, row.value),
  }))
  const from = vi.fn().mockImplementation(() => {
    let kind: 'schedule' | 'connection' = 'schedule'
    const chain: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      // The schedule read is paged (fetchAllRows).
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
      in: vi.fn().mockImplementation((column: string, values: string[]) => {
        if (column === 'key') {
          kind = values.some((v) => v.endsWith('_connection')) ? 'connection' : 'schedule'
        }
        return chain
      }),
      then: (resolve: (v: unknown) => void) => {
        if (kind === 'connection') {
          return resolve({
            data: options.connectionRows ?? [],
            error: options.connectionError ?? null,
          })
        }
        return resolve({
          data: listed,
          error: options.scheduleError ?? null,
        })
      },
    }
    return chain
  })
  return { from } as any
}

function scheduleRow(overrides: Record<string, unknown> = {}) {
  return {
    company_id: 'c-1',
    user_id: 'u-1',
    key: 'google_drive_schedule',
    value: {
      enabled: true,
      hour_utc: 12,
      last_auto_sync_at: null,
      last_auto_sync_status: null,
      last_auto_sync_error: null,
      ...overrides,
    },
  }
}

function connectionRow(companyId: string, value: unknown, key = 'google_drive_connection') {
  return { company_id: companyId, key, value }
}

function okSyncResult() {
  return {
    ok: true as const,
    lastSync: {
      at: '2026-07-12T12:30:00Z',
      folder_id: 'folder-1',
      files: [],
      total_size_bytes: 1000,
    },
    webViewLink: 'https://drive.google.com/drive/folders/folder-1',
    uploadedCount: 1,
    skippedCount: 0,
  }
}

describe('cloud-backup auto-sync cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ now: NOW })
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
    // Without credentials the cron deliberately skips a provider, so the
    // Google flow has to look configured for these tests to exercise it.
    process.env.GOOGLE_CLIENT_ID = 'client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret'
    delete process.env.DROPBOX_APP_KEY
    delete process.env.DROPBOX_APP_SECRET
    mockVerifyCronSecret.mockReturnValue(null)
    mockSendBackupFailureAlert.mockResolvedValue({ sent: true })
    records.rows.clear()
    records.writes.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns 401 when cron auth fails', async () => {
    mockVerifyCronSecret.mockReturnValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) as any
    )

    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('skips schedules that are disabled', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([scheduleRow({ enabled: false })])
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(0)
    expect(mockPerformSync).not.toHaveBeenCalled()
  })

  it('skips schedules whose slot is later today', async () => {
    mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow({ hour_utc: 13 })]))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(0)
    expect(mockPerformSync).not.toHaveBeenCalled()
  })

  it('catches up companies whose earlier slot was missed', async () => {
    // 03:00 slot, never synced: still due at 12:30 (e.g. after a time-budget overrun).
    mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow({ hour_utc: 3 })]))
    mockPerformSync.mockResolvedValueOnce(okSyncResult())

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.successes).toBe(1)
    expect(mockPerformSync).toHaveBeenCalledTimes(1)
  })

  it('skips schedules that already ran since today\'s slot', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([
        scheduleRow({ hour_utc: 3, last_auto_sync_at: '2026-07-12T03:05:00.000Z' }),
      ])
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(0)
    expect(mockPerformSync).not.toHaveBeenCalled()
  })

  it('runs again when the last attempt was yesterday', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([
        scheduleRow({ hour_utc: 12, last_auto_sync_at: '2026-07-11T12:05:00.000Z' }),
      ])
    )
    mockPerformSync.mockResolvedValueOnce(okSyncResult())

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.successes).toBe(1)
  })

  it('runs sync with document fallback and persists success state', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([scheduleRow({ consecutive_failures: 2 })])
    )
    mockPerformSync.mockResolvedValueOnce(okSyncResult())

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(mockPerformSync).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'c-1',
        userId: 'u-1',
        includeDocuments: true,
        allowDocumentFallback: true,
      })
    )
    expect(body.successes).toBe(1)

    const { scheduleKey: key, value } = outcomes()[0]
    expect(key).toBe('google_drive_schedule')
    expect((value as any).last_auto_sync_status).toBe('success')
    expect((value as any).last_auto_sync_error).toBeNull()
    // Success resets the failure counter.
    expect((value as any).consecutive_failures).toBe(0)
    expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
  })

  it('increments the failure counter without alerting below the threshold', async () => {
    mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow()]))
    mockPerformSync.mockResolvedValueOnce({
      ok: false,
      reason: 'upload_failed',
      message: 'Drive upload failed: 500',
    })

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    const { value } = outcomes()[0]
    expect((value as any).last_auto_sync_status).toBe('error')
    expect((value as any).consecutive_failures).toBe(1)
    expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
  })

  it('alerts when the consecutive failure threshold is reached', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([scheduleRow({ consecutive_failures: 2 })])
    )
    mockPerformSync.mockResolvedValueOnce({
      ok: false,
      reason: 'upload_failed',
      message: 'Drive upload failed: 500',
    })

    await GET(makeRequest())

    expect(mockSendBackupFailureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: 'c-1',
        kind: 'repeated_failures',
        consecutiveFailures: 3,
        errorMessage: 'Något gick fel. Försök igen, och kontakta support om det fortsätter.',
      })
    )
    const { value } = outcomes()[0]
    expect((value as any).consecutive_failures).toBe(3)
    expect((value as any).last_alert_at).toEqual(expect.any(String))
  })

  it('throttles repeat alerts via last_alert_at', async () => {
    const recentAlert = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString()
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([
        scheduleRow({ consecutive_failures: 5, last_alert_at: recentAlert }),
      ])
    )
    mockPerformSync.mockResolvedValueOnce({
      ok: false,
      reason: 'upload_failed',
      message: 'still failing',
    })

    await GET(makeRequest())

    expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
    const { value } = outcomes()[0]
    expect((value as any).last_alert_at).toBe(recentAlert)
  })

  it('alerts immediately when the token dies during the sync', async () => {
    mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow()]))
    mockPerformSync.mockResolvedValueOnce({
      ok: false,
      reason: 'needs_reauth',
      message: 'Google Drive authorization expired; reconnect required',
    })

    await GET(makeRequest())

    expect(mockSendBackupFailureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'needs_reauth' })
    )
  })

  it('passes a missing storage scope to the alert so the advice fits (B12)', async () => {
    mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow()]))
    mockPerformSync.mockResolvedValueOnce({
      ok: false,
      reason: 'needs_reauth',
      message: 'Google Drive access was granted without the storage permission; reconnect required',
      reauthReason: 'missing_scope',
    })

    const res = await GET(makeRequest())
    const body = await res.json()

    // Recorded as a failed attempt, then skipped as needs_reauth from now on.
    expect(body.errors).toBe(1)
    expect(mockSendBackupFailureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'needs_reauth', reauthReason: 'missing_scope' })
    )
  })

  it('gives every sync a file start deadline inside the function limit', async () => {
    mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow()]))
    mockPerformSync.mockResolvedValueOnce(okSyncResult())

    await GET(makeRequest())

    const deadline = mockPerformSync.mock.calls[0][0].startDeadline!
    expect(deadline).toBe(NOW.getTime() + 150_000)
  })

  it('starts no further company once the cutoff has passed', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([scheduleRow(), { ...scheduleRow(), company_id: 'c-2' }])
    )
    mockPerformSync.mockImplementationOnce(async () => {
      // The first company's upload runs past the 150 s cutoff.
      vi.setSystemTime(NOW.getTime() + 151_000)
      return okSyncResult()
    })

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(mockPerformSync).toHaveBeenCalledTimes(1)
    expect(body.processed).toBe(1)
    // c-2 was not attempted, so its schedule stays due for the next run.
    expect(outcomes()).toHaveLength(1)
  })

  it('leaves a deferred company due: no attempt recorded, no failure, no alert', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([scheduleRow({ consecutive_failures: 2 })])
    )
    mockPerformSync.mockResolvedValueOnce({
      ok: false,
      reason: 'deferred',
      message: 'time budget reached after 1 file(s); the next run resumes',
    })

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.deferred).toBe(1)
    expect(body.errors).toBe(0)
    expect(body.results).toEqual([
      { companyId: 'c-1', provider: 'google_drive', status: 'deferred' },
    ])
    // The one write releases the claim and notes the deferral: the attempt
    // fields and the failure count are as they were, so it stays due.
    expect(outcomes()).toHaveLength(1)
    const { value } = outcomes()[0]
    expect(value).toMatchObject({
      sync_started_at: null,
      deferred_at: NOW.toISOString(),
      last_auto_sync_at: null,
      last_auto_sync_status: null,
      consecutive_failures: 2,
    })
    expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
  })

  describe('queue order', () => {
    it('reads every schedule page by page in a stable order', async () => {
      const stub = makeSupabaseStub([scheduleRow()])
      mockCreateClient.mockReturnValueOnce(stub)
      mockPerformSync.mockResolvedValueOnce(okSyncResult())

      await GET(makeRequest())

      const scheduleChain = stub.from.mock.results[0].value
      expect(scheduleChain.order).toHaveBeenCalledWith('id', { ascending: true })
      expect(scheduleChain.range).toHaveBeenCalledWith(0, 999)
    })

    it('takes the company that has waited longest first, a deferred one last', async () => {
      mockCreateClient.mockReturnValueOnce(
        makeSupabaseStub([
          // Ran out of time an hour ago: it had its turn.
          { ...scheduleRow({ hour_utc: 3, last_auto_sync_at: '2026-07-10T03:00:00.000Z', deferred_at: '2026-07-12T11:02:00.000Z' }), company_id: 'c-deferred' },
          { ...scheduleRow({ hour_utc: 3, last_auto_sync_at: '2026-07-11T03:20:00.000Z' }), company_id: 'c-recent' },
          { ...scheduleRow({ hour_utc: 3, last_auto_sync_at: '2026-07-11T03:01:00.000Z' }), company_id: 'c-oldest' },
          { ...scheduleRow({ hour_utc: 3 }), company_id: 'c-never' },
        ])
      )
      mockPerformSync.mockResolvedValue(okSyncResult())

      await GET(makeRequest())

      expect(mockPerformSync.mock.calls.map(([params]) => params.companyId)).toEqual([
        'c-never',
        'c-oldest',
        'c-recent',
        'c-deferred',
      ])
    })
  })

  describe('run claim', () => {
    it('claims the schedule before the sync and releases it with the outcome', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow()]))
      mockPerformSync.mockImplementationOnce(async () => {
        expect(stored()).toMatchObject({ sync_started_at: NOW.toISOString(), sync_started_by: 'cron' })
        return okSyncResult()
      })

      await GET(makeRequest())

      expect(versioned()).toHaveLength(1)
      expect(stored()).toMatchObject({
        sync_started_at: null,
        sync_started_by: null,
        last_auto_sync_status: 'success',
      })
    })

    it('leaves a company another run is working on alone', async () => {
      mockCreateClient.mockReturnValueOnce(
        makeSupabaseStub([scheduleRow({ sync_started_at: '2026-07-12T12:29:30.000Z', sync_started_by: 'cron' })])
      )

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(records.writes).toEqual([])
      expect(mockPerformSync).not.toHaveBeenCalled()
      expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
      expect(body.results).toEqual([
        { companyId: 'c-1', provider: 'google_drive', status: 'skipped', error: 'in_progress' },
      ])
    })

    it('does not sync when another run takes the claim between the read and the write', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow()]))
      mockVersionedWrite.mockResolvedValueOnce(null)

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(mockPerformSync).not.toHaveBeenCalled()
      expect(records.writes).toEqual([])
      expect(body.skipped).toBe(1)
    })

    it('a late second delivery leaves a company the first one finished: no second run, no second mail, its result kept', async () => {
      // Both deliveries read their rows while the company was still due,
      // with two failed nights behind it.
      mockCreateClient.mockReturnValueOnce(
        makeSupabaseStub([scheduleRow({ hour_utc: 3, consecutive_failures: 2 })])
      )
      // The first delivery has since run it: third failure, the mail sent,
      // the claim released. This one reaches the company only now.
      const firstResult = {
        sync_started_at: null,
        last_auto_sync_at: '2026-07-12T12:29:40.000Z',
        last_auto_sync_status: 'error',
        last_auto_sync_error: 'Något gick fel. Försök igen, och kontakta support om det fortsätter.',
        consecutive_failures: 3,
        last_alert_at: '2026-07-12T12:29:40.000Z',
      }
      writeElsewhere(firstResult)

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(mockPerformSync).not.toHaveBeenCalled()
      expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
      expect(records.writes).toEqual([])
      expect(stored()).toMatchObject(firstResult)
      expect(body.results).toEqual([
        { companyId: 'c-1', provider: 'google_drive', status: 'skipped', error: 'no_longer_due' },
      ])
    })

    it('a late second delivery leaves a company the first one ran out of time on', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow({ hour_utc: 3 })]))
      writeElsewhere({ sync_started_at: null, deferred_at: '2026-07-12T12:29:50.000Z' })

      await GET(makeRequest())

      expect(mockPerformSync).not.toHaveBeenCalled()
      expect(records.writes).toEqual([])
    })

    it('keeps a schedule the person edited after the run read its rows: the claim is built on the record as it is', async () => {
      mockCreateClient.mockReturnValueOnce(
        makeSupabaseStub([scheduleRow({ hour_utc: 3, hour_local: 5 })])
      )
      // Moved to another hour that has also passed, so it is still due.
      writeElsewhere({ hour_utc: 4, hour_local: 6 })
      mockPerformSync.mockResolvedValueOnce(okSyncResult())

      await GET(makeRequest())

      expect(versioned()[0].value).toMatchObject({ hour_utc: 4, hour_local: 6, sync_started_at: NOW.toISOString() })
      expect(stored()).toMatchObject({ hour_utc: 4, hour_local: 6, last_auto_sync_status: 'success' })
    })

    it('does not run a schedule the person switched off after the run read its rows', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow({ hour_utc: 3 })]))
      writeElsewhere({ enabled: false })

      await GET(makeRequest())

      expect(mockPerformSync).not.toHaveBeenCalled()
      expect(stored().enabled).toBe(false)
    })

    it('keeps a schedule the person edited while its backup ran: the outcome goes on top of the edit', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow({ hour_utc: 3, hour_local: 5 })]))
      mockPerformSync.mockImplementationOnce(async () => {
        // PUT /schedule keeps the claim it finds and changes the hour.
        writeElsewhere({ hour_utc: 20, hour_local: 22, enabled: false })
        return okSyncResult()
      })

      await GET(makeRequest())

      expect(stored()).toMatchObject({
        hour_utc: 20,
        hour_local: 22,
        enabled: false,
        sync_started_at: null,
        last_auto_sync_status: 'success',
        consecutive_failures: 0,
      })
    })

    it('counts a cron claim nobody released as a failed night and tries the company once more', async () => {
      // Claimed by the 11:00 run, which the platform ended mid-upload.
      mockCreateClient.mockReturnValueOnce(
        makeSupabaseStub([
          scheduleRow({
            hour_utc: 3,
            consecutive_failures: 1,
            sync_started_at: '2026-07-12T11:02:10.000Z',
            sync_started_by: 'cron',
          }),
        ])
      )
      mockPerformSync.mockResolvedValueOnce({
        ok: false,
        reason: 'upload_failed',
        message: 'Drive upload failed: 500',
      })

      await GET(makeRequest())

      expect(versioned()[0].value).toMatchObject({
        sync_started_at: NOW.toISOString(),
        interrupted_at: NOW.toISOString(),
        consecutive_failures: 2,
      })
      expect(logError).toHaveBeenCalledWith(
        'cloud backup run was ended before this company finished',
        undefined,
        expect.objectContaining({ companyId: 'c-1', consecutiveFailures: 2, retried: true })
      )
      expect(mockPerformSync).toHaveBeenCalledTimes(1)
      // The retry failing too is the same night: counted once, not twice.
      expect(stored()).toMatchObject({ consecutive_failures: 2, sync_started_at: null })
    })

    it('takes over a claim a manual run never released without counting a failed night', async () => {
      // "Synka nu" at 11:02 on a large company, ended at the route's limit.
      mockCreateClient.mockReturnValueOnce(
        makeSupabaseStub([
          scheduleRow({
            hour_utc: 3,
            consecutive_failures: 0,
            sync_started_at: '2026-07-12T11:02:10.000Z',
            sync_started_by: 'manual',
          }),
        ])
      )
      mockPerformSync.mockResolvedValueOnce(okSyncResult())

      await GET(makeRequest())

      expect(versioned()[0].value).toMatchObject({ sync_started_by: 'cron', consecutive_failures: 0 })
      expect(versioned()[0].value).not.toHaveProperty('interrupted_at')
      expect(logError).not.toHaveBeenCalled()
      expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
      expect(stored()).toMatchObject({ last_auto_sync_status: 'success', consecutive_failures: 0 })
    })

    it('records the night as failed, with the mail at three, when the retry was killed too', async () => {
      mockCreateClient.mockReturnValueOnce(
        makeSupabaseStub([
          scheduleRow({
            hour_utc: 3,
            consecutive_failures: 3,
            // Counted and retried at 11:00; that run never released it either.
            interrupted_at: '2026-07-12T11:00:20.000Z',
            sync_started_at: '2026-07-12T11:00:20.000Z',
            sync_started_by: 'cron',
          }),
        ])
      )

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(mockPerformSync).not.toHaveBeenCalled()
      expect(versioned()[0].value).toMatchObject({
        sync_started_at: null,
        last_auto_sync_at: NOW.toISOString(),
        last_auto_sync_status: 'error',
        consecutive_failures: 3,
      })
      expect(mockSendBackupFailureAlert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'repeated_failures', consecutiveFailures: 3 })
      )
      expect(stored().last_alert_at).toBe(NOW.toISOString())
      expect(body.errors).toBe(1)
    })
  })

  describe('an outcome that cannot be recorded', () => {
    const failing = () =>
      mockPerformSync.mockResolvedValueOnce({ ok: false, reason: 'upload_failed', message: 'Drive upload failed: 500' })

    it('is an error that says a failure mail already went out, so a second mail next run can be explained', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow({ consecutive_failures: 2 })]))
      failing()
      mockPatch.mockResolvedValueOnce('lost')

      await GET(makeRequest())

      expect(mockSendBackupFailureAlert).toHaveBeenCalledTimes(1)
      expect(logError).toHaveBeenCalledWith(
        'failed to persist sync outcome after a failure mail was sent: the next run may count this failure and mail again',
        undefined,
        expect.objectContaining({ companyId: 'c-1', failureMailSent: true, outcome: 'lost' })
      )
    })

    it('is an error without that note when no mail went out', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow()]))
      failing()
      mockPatch.mockResolvedValueOnce('left')

      await GET(makeRequest())

      expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
      expect(logError).toHaveBeenCalledWith(
        'failed to persist sync outcome',
        undefined,
        expect.objectContaining({ failureMailSent: false, outcome: 'left' })
      )
    })

    it('does not say a mail went out when a deferral cannot be recorded: a deferral sends none', async () => {
      // An earlier night's mail is on the record; this run only ran out of time.
      mockCreateClient.mockReturnValueOnce(
        makeSupabaseStub([scheduleRow({ consecutive_failures: 3, last_alert_at: '2026-07-10T03:05:00.000Z' })])
      )
      mockPerformSync.mockResolvedValueOnce({
        ok: false,
        reason: 'deferred',
        message: 'time budget reached after 1 file(s); the next run resumes',
      })
      mockPatch.mockResolvedValueOnce('lost')

      await GET(makeRequest())

      expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
      expect(logError).toHaveBeenCalledWith(
        'failed to persist deferral',
        undefined,
        expect.objectContaining({ companyId: 'c-1', failureMailSent: false, outcome: 'lost' })
      )
    })

    it('is only a warning when the destination was disconnected during the run', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow({ consecutive_failures: 2 })]))
      failing()
      mockPatch.mockResolvedValueOnce('gone')

      await GET(makeRequest())

      expect(logError).not.toHaveBeenCalledWith(expect.stringContaining('failed to persist'), undefined, expect.anything())
      expect(logWarn).toHaveBeenCalledWith(
        'sync outcome not recorded: the destination was disconnected during the run',
        expect.objectContaining({ companyId: 'c-1', failureMailSent: true })
      )
    })
  })

  describe('companies left over at the time budget', () => {
    const overrun = () =>
      mockPerformSync.mockImplementationOnce(async () => {
        vi.setSystemTime(NOW.getTime() + 151_000)
        return okSyncResult()
      })
    const second = (overrides: Record<string, unknown> = {}) => ({
      ...scheduleRow({ last_auto_sync_at: '2026-07-11T12:05:00.000Z', ...overrides }),
      company_id: 'c-2',
    })
    const first = () => scheduleRow({ last_auto_sync_at: '2026-07-11T12:01:00.000Z' })

    it('counts the run on the record and stays an info line when the batch only spills into the next hour', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([first(), second()]))
      overrun()

      await GET(makeRequest())

      expect(stored('c-2').left_over_runs).toBe(1)
      expect(logError).not.toHaveBeenCalled()
    })

    it('is an error on the third due run in a row that did not reach a company, whatever the clock says', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([first(), second({ left_over_runs: 2 })]))
      overrun()

      await GET(makeRequest())

      expect(stored('c-2').left_over_runs).toBe(3)
      expect(logError).toHaveBeenCalledWith(
        'cloud backups left over at the time budget run after run',
        undefined,
        expect.objectContaining({ leftOver: 1, threeRunsInARow: 1, aDayOfRuns: 0, hoursSinceOldestBackupAttempt: 24 })
      )
    })

    it('says it once: the fourth run counts on without another error, a full day is one more', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([first(), second({ left_over_runs: 3 })]))
      overrun()
      await GET(makeRequest())
      expect(stored('c-2').left_over_runs).toBe(4)
      expect(logError).not.toHaveBeenCalled()

      vi.setSystemTime(NOW)
      records.rows.clear()
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([first(), second({ left_over_runs: 23 })]))
      overrun()
      await GET(makeRequest())
      expect(logError).toHaveBeenCalledWith(
        'cloud backups left over at the time budget run after run',
        undefined,
        expect.objectContaining({ threeRunsInARow: 0, aDayOfRuns: 1 })
      )
    })

    it('counts them the moment the cutoff passes, while the last company\'s file is still uploading', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([first(), second()]))
      let countedDuringUpload: number | undefined
      mockPerformSync.mockImplementationOnce(async () => {
        // The cutoff passes mid-upload; an upload that then overruns is
        // ended at the function's limit, with anything after the loop.
        await vi.advanceTimersByTimeAsync(150_000)
        for (let i = 0; i < 20; i++) await Promise.resolve()
        countedDuringUpload = stored('c-2').left_over_runs
        return okSyncResult()
      })

      await GET(makeRequest())

      expect(countedDuringUpload).toBe(1)
      // Counted once, not again after the loop.
      expect(stored('c-2').left_over_runs).toBe(1)
      expect(mockPerformSync).toHaveBeenCalledTimes(1)
    })

    it('logs a count it could not write', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([first(), second()]))
      overrun()
      const original = mockVersionedWrite.getMockImplementation()!
      mockVersionedWrite.mockImplementation(async (supabase, key, version, value) => {
        if (key.companyId === 'c-2') throw new Error('connection reset')
        return original(supabase, key, version, value)
      })

      try {
        await GET(makeRequest())
      } finally {
        mockVersionedWrite.mockImplementation(original)
      }

      expect(logError).toHaveBeenCalledWith(
        'failed to count cloud backups left over at the time budget',
        expect.objectContaining({ message: 'connection reset' }),
        { failedWrites: 1, leftOver: 1 }
      )
    })

    it('starts the count over when the company gets its turn', async () => {
      mockCreateClient.mockReturnValueOnce(makeSupabaseStub([scheduleRow({ left_over_runs: 5 })]))
      mockPerformSync.mockResolvedValueOnce(okSyncResult())

      await GET(makeRequest())

      expect(stored().left_over_runs).toBe(0)
    })
  })

  it('catches thrown errors, counts them and records them against the schedule', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([scheduleRow({ consecutive_failures: 2 })])
    )
    mockPerformSync.mockRejectedValueOnce(new Error('Drive quota exceeded'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    expect(mockSendBackupFailureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'repeated_failures', consecutiveFailures: 3 })
    )
    const { value } = outcomes()[0]
    expect((value as any).last_auto_sync_status).toBe('error')
    expect((value as any).last_auto_sync_error).toBe('Något gick fel. Försök igen, och kontakta support om det fortsätter.')
    expect((value as any).consecutive_failures).toBe(3)
  })

  it('skips pre-flagged needs_reauth connections and alerts once per incident', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([scheduleRow()], {
        connectionRows: [
          connectionRow('c-1', { status: 'needs_reauth', needs_reauth_at: '2026-07-10T03:00:00.000Z' }),
        ],
      })
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(mockPerformSync).not.toHaveBeenCalled()
    expect(body.skipped).toBe(1)
    expect(body.results).toEqual([
      { companyId: 'c-1', provider: 'google_drive', status: 'skipped', error: 'needs_reauth' },
    ])
    // The incident had not been alerted yet: one alert, persisted on the schedule.
    expect(mockSendBackupFailureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'needs_reauth' })
    )
    expect(outcomes()).toHaveLength(1)
    const { value } = outcomes()[0]
    expect((value as any).last_alert_at).toEqual(expect.any(String))
    // last_auto_sync_* stays untouched: it keeps showing the original failure.
    expect((value as any).last_auto_sync_at).toBeNull()
  })

  it('alerts a pre-flagged missing-scope connection with its reason', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([scheduleRow()], {
        connectionRows: [
          connectionRow('c-1', {
            status: 'needs_reauth',
            needs_reauth_at: '2026-07-10T03:00:00.000Z',
            needs_reauth_reason: 'missing_scope',
          }),
        ],
      })
    )

    await GET(makeRequest())

    expect(mockPerformSync).not.toHaveBeenCalled()
    expect(mockSendBackupFailureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'needs_reauth', reauthReason: 'missing_scope' })
    )
  })

  it('does not re-alert an already alerted needs_reauth incident', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub(
        [scheduleRow({ last_alert_at: '2026-07-10T04:00:00.000Z' })],
        {
          connectionRows: [
            connectionRow('c-1', { status: 'needs_reauth', needs_reauth_at: '2026-07-10T03:00:00.000Z' }),
          ],
        }
      )
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.skipped).toBe(1)
    expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
    expect(outcomes()).toHaveLength(0)
  })

  it('only skips the flagged company when others are due', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub(
        [
          { ...scheduleRow(), company_id: 'c-dead' },
          { ...scheduleRow(), company_id: 'c-live', user_id: 'u-2' },
        ],
        {
          connectionRows: [
            connectionRow('c-dead', { status: 'needs_reauth', needs_reauth_at: '2026-07-10T03:00:00.000Z' }),
            connectionRow('c-live', { status: 'active' }),
          ],
        }
      )
    )
    mockPerformSync.mockResolvedValueOnce(okSyncResult())

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(mockPerformSync).toHaveBeenCalledTimes(1)
    expect(mockPerformSync).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'c-live' })
    )
    expect(body.skipped).toBe(1)
    expect(body.successes).toBe(1)
  })

  it('runs both providers for the same company as independent jobs', async () => {
    process.env.DROPBOX_APP_KEY = 'app-key'
    process.env.DROPBOX_APP_SECRET = 'app-secret'
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([
        scheduleRow(),
        { ...scheduleRow(), key: 'dropbox_schedule' },
      ])
    )
    mockPerformSync.mockResolvedValue(okSyncResult())

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(mockPerformSync).toHaveBeenCalledTimes(2)
    const targets = mockPerformSync.mock.calls.map((c) => c[0].provider?.id)
    expect(targets).toEqual(['google_drive', 'dropbox'])
    // Each writes back to its own schedule record.
    const writtenKeys = outcomes().map((write) => write.scheduleKey)
    expect(writtenKeys).toEqual(['google_drive_schedule', 'dropbox_schedule'])
    expect(body.successes).toBe(2)
  })

  it('keeps one provider running when the other holds a dead token', async () => {
    process.env.DROPBOX_APP_KEY = 'app-key'
    process.env.DROPBOX_APP_SECRET = 'app-secret'
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub(
        [scheduleRow(), { ...scheduleRow(), key: 'dropbox_schedule' }],
        {
          connectionRows: [
            connectionRow(
              'c-1',
              { status: 'needs_reauth', needs_reauth_at: '2026-07-10T03:00:00.000Z' },
              'dropbox_connection'
            ),
            connectionRow('c-1', { status: 'active' }),
          ],
        }
      )
    )
    mockPerformSync.mockResolvedValue(okSyncResult())

    const res = await GET(makeRequest())
    const body = await res.json()

    // A dead Dropbox token must not stop the healthy Drive backup.
    expect(mockPerformSync).toHaveBeenCalledTimes(1)
    expect(mockPerformSync.mock.calls[0][0].provider?.id).toBe('google_drive')
    expect(body.successes).toBe(1)
    expect(body.skipped).toBe(1)
    expect(mockSendBackupFailureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'needs_reauth', providerLabel: 'Dropbox' })
    )
  })

  it('skips a due schedule whose provider has no credentials here', async () => {
    // Dropbox stays unconfigured (see beforeEach): the schedule exists but the
    // deployment cannot honour it, so it must not burn the failure counter.
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([{ ...scheduleRow(), key: 'dropbox_schedule' }])
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(mockPerformSync).not.toHaveBeenCalled()
    expect(outcomes()).toHaveLength(0)
    expect(body.processed).toBe(0)
  })

  it('fails open and attempts the sync when the connection lookup errors', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([scheduleRow()], {
        connectionError: { message: 'connection query failed' },
      })
    )
    mockPerformSync.mockResolvedValueOnce({
      ok: false,
      reason: 'needs_reauth',
      message: 'Google Drive authorization expired; reconnect required',
    })

    const res = await GET(makeRequest())
    const body = await res.json()

    // performSync is still attempted (it re-flags dead tokens itself).
    expect(mockPerformSync).toHaveBeenCalledTimes(1)
    expect(body.errors).toBe(1)
  })
})
