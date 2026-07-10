/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/extensions/general/cloud-backup/lib/sync', () => ({
  performSync: vi.fn(),
  CONNECTION_KEY: 'google_drive_connection',
  SCHEDULE_KEY: 'google_drive_schedule',
  saveExtensionData: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn().mockReturnValue(null),
}))

import { GET } from '../route'
import { createClient } from '@supabase/supabase-js'
import {
  performSync,
  saveExtensionData,
} from '@/extensions/general/cloud-backup/lib/sync'
import { verifyCronSecret } from '@/lib/auth/cron'

const mockCreateClient = vi.mocked(createClient)
const mockPerformSync = vi.mocked(performSync)
const mockSaveExtensionData = vi.mocked(saveExtensionData)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)

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

describe('cloud-backup auto-sync cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
    mockVerifyCronSecret.mockReturnValue(null)
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
      makeSupabaseStub([
        {
          company_id: 'c-1',
          user_id: 'u-1',
          value: { enabled: false, hour_utc: new Date().getUTCHours() },
        },
      ])
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(0)
    expect(mockPerformSync).not.toHaveBeenCalled()
  })

  it('skips schedules whose hour does not match the current UTC hour', async () => {
    const offHour = (new Date().getUTCHours() + 5) % 24
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([
        {
          company_id: 'c-1',
          user_id: 'u-1',
          value: { enabled: true, hour_utc: offHour },
        },
      ])
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(0)
    expect(mockPerformSync).not.toHaveBeenCalled()
  })

  it('skips schedules whose last_auto_sync_at is less than 20h ago', async () => {
    const recent = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([
        {
          company_id: 'c-1',
          user_id: 'u-1',
          value: {
            enabled: true,
            hour_utc: new Date().getUTCHours(),
            last_auto_sync_at: recent,
          },
        },
      ])
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(0)
    expect(mockPerformSync).not.toHaveBeenCalled()
  })

  it('runs sync and persists success for qualifying schedules', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([
        {
          company_id: 'c-1',
          user_id: 'u-1',
          value: {
            enabled: true,
            hour_utc: new Date().getUTCHours(),
            last_auto_sync_at: null,
          },
        },
      ])
    )
    mockPerformSync.mockResolvedValueOnce({
      ok: true,
      lastSync: {
        at: '2026-04-20T03:00:00Z',
        file_id: 'f-1',
        file_name: 'arkiv.zip',
        file_size_bytes: 1000,
        folder_id: 'folder-1',
      },
      webViewLink: 'https://drive.google.com/file/d/f-1/view',
    })

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(mockPerformSync).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'c-1',
        userId: 'u-1',
        includeDocuments: true,
      })
    )
    expect(body.successes).toBe(1)
    expect(body.errors).toBe(0)

    // Persisted the success state on the schedule
    const [, , , key, value] = mockSaveExtensionData.mock.calls[0]
    expect(key).toBe('google_drive_schedule')
    expect((value as any).last_auto_sync_status).toBe('success')
    expect((value as any).last_auto_sync_error).toBeNull()
  })

  it('records error status when performSync returns ok=false', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([
        {
          company_id: 'c-1',
          user_id: 'u-1',
          value: {
            enabled: true,
            hour_utc: new Date().getUTCHours(),
            last_auto_sync_at: null,
          },
        },
      ])
    )
    mockPerformSync.mockResolvedValueOnce({
      ok: false,
      reason: 'archive_too_large',
      message: 'Archive exceeds size limit',
      size_bytes: 100 * 1024 * 1024,
      size_limit_bytes: 80 * 1024 * 1024,
    })

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.successes).toBe(0)
    expect(body.errors).toBe(1)
    const [, , , , value] = mockSaveExtensionData.mock.calls[0]
    expect((value as any).last_auto_sync_status).toBe('error')
    expect((value as any).last_auto_sync_error).toBe('Archive exceeds size limit')
  })

  it('catches thrown errors and records them against the schedule', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub([
        {
          company_id: 'c-1',
          user_id: 'u-1',
          value: {
            enabled: true,
            hour_utc: new Date().getUTCHours(),
            last_auto_sync_at: null,
          },
        },
      ])
    )
    mockPerformSync.mockRejectedValueOnce(new Error('Drive quota exceeded'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    const [, , , , value] = mockSaveExtensionData.mock.calls[0]
    expect((value as any).last_auto_sync_status).toBe('error')
    expect((value as any).last_auto_sync_error).toContain('Drive quota exceeded')
  })

  it('skips connections flagged needs_reauth without syncing or touching the schedule', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub(
        [
          {
            company_id: 'c-1',
            user_id: 'u-1',
            value: {
              enabled: true,
              hour_utc: new Date().getUTCHours(),
              last_auto_sync_at: null,
            },
          },
        ],
        {
          connectionRows: [
            { company_id: 'c-1', value: { status: 'needs_reauth' } },
          ],
        }
      )
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(mockPerformSync).not.toHaveBeenCalled()
    expect(mockSaveExtensionData).not.toHaveBeenCalled()
    expect(body.skipped).toBe(1)
    expect(body.successes).toBe(0)
    expect(body.errors).toBe(0)
    expect(body.results).toEqual([
      { companyId: 'c-1', status: 'skipped', error: 'needs_reauth' },
    ])
  })

  it('only skips the flagged company when others are due', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub(
        [
          {
            company_id: 'c-dead',
            user_id: 'u-1',
            value: {
              enabled: true,
              hour_utc: new Date().getUTCHours(),
              last_auto_sync_at: null,
            },
          },
          {
            company_id: 'c-live',
            user_id: 'u-2',
            value: {
              enabled: true,
              hour_utc: new Date().getUTCHours(),
              last_auto_sync_at: null,
            },
          },
        ],
        {
          connectionRows: [
            { company_id: 'c-dead', value: { status: 'needs_reauth' } },
            { company_id: 'c-live', value: { status: 'active' } },
          ],
        }
      )
    )
    mockPerformSync.mockResolvedValueOnce({
      ok: true,
      lastSync: {
        at: '2026-07-10T03:00:00Z',
        file_id: 'f-1',
        file_name: 'arkiv.zip',
        file_size_bytes: 1000,
        folder_id: 'folder-1',
      },
      webViewLink: 'https://drive.google.com/file/d/f-1/view',
    })

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
      makeSupabaseStub(
        [
          {
            company_id: 'c-1',
            user_id: 'u-1',
            value: {
              enabled: true,
              hour_utc: new Date().getUTCHours(),
              last_auto_sync_at: null,
            },
          },
        ],
        { connectionError: { message: 'connection query failed' } }
      )
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
