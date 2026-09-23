import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { resetManualSyncThrottle } from '@/lib/connect/instance/manual-sync-throttle'

let selfHosted = true
vi.mock('@/lib/env/public-flags', () => ({ isSelfHosted: () => selfHosted }))

const captured = vi.hoisted(() => ({ options: undefined as { requireWrite?: boolean } | undefined }))
vi.mock('@/lib/api/with-route-context', () => ({
  withRouteContext: (
    _op: string,
    handler: (req: unknown, ctx: unknown) => unknown,
    options?: { requireWrite?: boolean },
  ) => {
    captured.options = options
    return (req: unknown) =>
      handler(req, {
        supabase: {},
        companyId: 'company-1',
        user: { id: 'u1' },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      })
  },
}))

const syncMock = vi.fn()
vi.mock('@/lib/connect/instance/sync', () => ({
  syncConnectorEntitlements: (...args: unknown[]) => syncMock(...args),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ __service: true }) }))

import { POST } from '../route'

const run = () => POST(createMockRequest('/api/connector/sync', { method: 'POST' }), { params: Promise.resolve({}) })

beforeEach(() => {
  vi.clearAllMocks()
  resetManualSyncThrottle()
  selfHosted = true
  vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_secretsecret')
  syncMock.mockResolvedValue({ outcome: 'synced', companies: 2, grantsUpserted: 4, grantsDeleted: 0, scopes: ['bank_sync'] })
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/connector/sync', () => {
  it('requires a non-viewer role', () => {
    expect(captured.options).toEqual({ requireWrite: true })
  })

  it('answers not_configured on hosted without running the sync', async () => {
    selfHosted = false
    const { status, body } = await parseJsonResponse<{ data: { outcome: string } }>(await run())
    expect(status).toBe(200)
    expect(body.data.outcome).toBe('not_configured')
    expect(syncMock).not.toHaveBeenCalled()
  })

  it('answers not_configured when no connector key is set', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
    const { body } = await parseJsonResponse<{ data: { outcome: string } }>(await run())
    expect(body.data.outcome).toBe('not_configured')
    expect(syncMock).not.toHaveBeenCalled()
  })

  it('runs the entitlement sync with the service client and returns the result', async () => {
    const { status, body } = await parseJsonResponse<{ data: { outcome: string; grantsUpserted: number } }>(await run())
    expect(status).toBe(200)
    expect(body.data.outcome).toBe('synced')
    expect(body.data.grantsUpserted).toBe(4)
    expect(syncMock).toHaveBeenCalledTimes(1)
    expect(syncMock.mock.calls[0][0]).toEqual({ __service: true })
    expect(Object.keys(syncMock.mock.calls[0][1] as object)).toEqual(
      expect.arrayContaining(['instanceUrl', 'appVersion']),
    )
  })

  it('refuses a second run inside the cooldown window', async () => {
    await run()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await run())
    expect(status).toBe(429)
    expect(body.error.code).toBe('CONNECTOR_SYNC_COOLDOWN')
    expect(syncMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the cooldown even when the sync throws', async () => {
    syncMock.mockRejectedValueOnce(new Error('db down'))
    await expect(run()).rejects.toThrow('db down')
    const { status } = await parseJsonResponse<{ error: { code: string } }>(await run())
    expect(status).toBe(429)
  })
})
