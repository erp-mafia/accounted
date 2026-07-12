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

import { GET } from '../route'
import { createClient } from '@supabase/supabase-js'
import {
  performSync,
  saveExtensionData,
} from '@/extensions/general/cloud-backup/lib/sync'
import { sendBackupFailureAlert } from '@/extensions/general/cloud-backup/lib/backup-alert'
import { verifyCronSecret } from '@/lib/auth/cron'

const mockCreateClient = vi.mocked(createClient)
const mockPerformSync = vi.mocked(performSync)
const mockSaveExtensionData = vi.mocked(saveExtensionData)
const mockSendBackupFailureAlert = vi.mocked(sendBackupFailureAlert)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)

// All tests run at a frozen 2026-07-12 12:30 UTC.
const NOW = new Date('2026-07-12T12:30:00.000Z')

function makeRequest() {
  return new Request('http://localhost/api/extensions/cloud-backup/auto-sync/cron', {
    headers: { authorization: 'Bearer test-secret' },
  })
}

/**
 * The route issues two queries against extension_data: schedules
 * (key = google_drive_schedule) and connections (key = google_drive_connection,
 * with an .in() filter). Route rows to the right result by the `key` eq filter.
 */
function makeSupabaseStub(
  scheduleRows: unknown[],
  options: {
    scheduleError?: unknown
    connectionRows?: unknown[]
    connectionError?: unknown
  } = {}
) {
  const from = vi.fn().mockImplementation(() => {
    let key: string | null = null
    const chain: any = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockImplementation((column: string, value: string) => {
        if (column === 'key') key = value
        return chain
      }),
      then: (resolve: (v: unknown) => void) => {
        if (key === 'google_drive_connection') {
          return resolve({
            data: options.connectionRows ?? [],
            error: options.connectionError ?? null,
          })
        }
        return resolve({
          data: scheduleRows,
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
    mockVerifyCronSecret.mockReturnValue(null)
    mockSendBackupFailureAlert.mockResolvedValue({ sent: true })
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

    const [, , , key, value] = mockSaveExtensionData.mock.calls[0]
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
    const [, , , , value] = mockSaveExtensionData.mock.calls[0]
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
        errorMessage: 'Drive upload failed: 500',
      })
    )
    const [, , , , value] = mockSaveExtensionData.mock.calls[0]
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
    const [, , , , value] = mockSaveExtensionData.mock.calls[0]
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
    const [, , , , value] = mockSaveExtensionData.mock.calls[0]
    expect((value as any).last_auto_sync_status).toBe('error')
    expect((value as any).last_auto_sync_error).toContain('Drive quota exceeded')
    expect((value as any).consecutive_failures).toBe(3)
  })

  it('skips pre-flagged needs_reauth connections and alerts once per incident', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([scheduleRow()], {
        connectionRows: [
          {
            company_id: 'c-1',
            value: { status: 'needs_reauth', needs_reauth_at: '2026-07-10T03:00:00.000Z' },
          },
        ],
      })
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(mockPerformSync).not.toHaveBeenCalled()
    expect(body.skipped).toBe(1)
    expect(body.results).toEqual([
      { companyId: 'c-1', status: 'skipped', error: 'needs_reauth' },
    ])
    // The incident had not been alerted yet: one alert, persisted on the schedule.
    expect(mockSendBackupFailureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'needs_reauth' })
    )
    expect(mockSaveExtensionData).toHaveBeenCalledTimes(1)
    const [, , , , value] = mockSaveExtensionData.mock.calls[0]
    expect((value as any).last_alert_at).toEqual(expect.any(String))
    // last_auto_sync_* stays untouched: it keeps showing the original failure.
    expect((value as any).last_auto_sync_at).toBeNull()
  })

  it('does not re-alert an already alerted needs_reauth incident', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub(
        [scheduleRow({ last_alert_at: '2026-07-10T04:00:00.000Z' })],
        {
          connectionRows: [
            {
              company_id: 'c-1',
              value: { status: 'needs_reauth', needs_reauth_at: '2026-07-10T03:00:00.000Z' },
            },
          ],
        }
      )
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.skipped).toBe(1)
    expect(mockSendBackupFailureAlert).not.toHaveBeenCalled()
    expect(mockSaveExtensionData).not.toHaveBeenCalled()
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
            {
              company_id: 'c-dead',
              value: { status: 'needs_reauth', needs_reauth_at: '2026-07-10T03:00:00.000Z' },
            },
            { company_id: 'c-live', value: { status: 'active' } },
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
