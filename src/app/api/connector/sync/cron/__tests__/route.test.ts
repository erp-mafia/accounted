import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  sync: vi.fn(),
}))

vi.mock('@/lib/api/with-cron-context', () => ({
  withCronContext:
    (_name: string, handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request) =>
      handler(req, { log: { info: h.logInfo, error: h.logError, warn: vi.fn() }, requestId: 'cron_test' }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}))
vi.mock('@/lib/connect/instance/sync', () => ({
  syncConnectorEntitlements: (...args: unknown[]) => h.sync(...args),
}))

import { GET } from '../route'

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/connector/sync/cron', () => {
  it('answers not_configured without a key and never calls the sync', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
    const res = await GET(new Request('http://localhost:3000/api/connector/sync/cron'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { outcome: 'not_configured' } })
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('runs the sync with the instance origin and returns its result', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://bokforing.example.se')
    h.sync.mockResolvedValue({ outcome: 'synced', companies: 2, grantsUpserted: 8, grantsDeleted: 0 })
    const res = await GET(new Request('http://localhost:3000/api/connector/sync/cron'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { outcome: 'synced', companies: 2, grantsUpserted: 8, grantsDeleted: 0 } })
    expect(h.sync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ instanceUrl: 'https://bokforing.example.se' }))
    expect(h.logInfo).toHaveBeenCalled()
  })

  it('logs and returns an error envelope when the sync throws', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    h.sync.mockRejectedValue(new Error('Failed to upsert connector grants: boom'))
    const res = await GET(new Request('http://localhost:3000/api/connector/sync/cron'))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(h.logError).toHaveBeenCalled()
  })
})
