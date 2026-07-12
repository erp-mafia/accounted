import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cloudBackupExtension } from '../index'
import { isScheduleDue } from '../lib/schedule'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { GoogleDriveSchedule } from '../types'

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

function makeContext(existing: GoogleDriveSchedule | null): {
  ctx: ExtensionContext
  set: ReturnType<typeof vi.fn>
} {
  const set = vi.fn().mockResolvedValue(undefined)
  const ctx = {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'cloud-backup',
    requestId: 'req_test',
    supabase: {},
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(existing),
      set,
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ExtensionContext
  return { ctx, set }
}

describe('PUT /schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears a stale hour_local on an hour_utc-only update so the UTC hour wins', async () => {
    // Existing schedule fires at 05:00 Stockholm (03:00 UTC in summer).
    const existing: GoogleDriveSchedule = {
      enabled: true,
      hour_utc: 3,
      hour_local: 5,
      last_auto_sync_at: null,
      last_auto_sync_status: null,
      last_auto_sync_error: null,
    }
    const { ctx, set } = makeContext(existing)

    // Legacy UTC-only client moves the schedule to 14:00 UTC.
    const res = await findRoute('PUT', '/schedule').handler(
      makeRequest({ enabled: true, hour_utc: 14 }),
      ctx
    )
    expect(res.status).toBe(200)

    expect(set).toHaveBeenCalledTimes(1)
    const stored = set.mock.calls[0][1] as GoogleDriveSchedule
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
    const stored = set.mock.calls[0][1] as GoogleDriveSchedule
    expect(stored.hour_local).toBe(5)
    expect([3, 4]).toContain(stored.hour_utc) // CEST vs CET mirror
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
