import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  delete: vi.fn(),
  lte: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }))
vi.mock('@/lib/observability', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

import { GET } from '../route'

describe('provider OAuth expiry cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'test-cron-secret')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
    mocks.createServiceClient.mockReturnValue({ from: mocks.from })
    mocks.from.mockReturnValue({ delete: mocks.delete })
    mocks.delete.mockReturnValue({ lte: mocks.lte })
    mocks.lte.mockResolvedValue({ count: 3, error: null })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  function request(authorization = 'Bearer test-cron-secret') {
    return new Request('https://app.accounted.se/api/extensions/arcim-migration/cleanup/cron', {
      headers: authorization ? { authorization } : {},
    })
  }

  it.each(['', 'Bearer wrong-secret'])('rejects unauthorized requests before database access (%s)', async (authorization) => {
    const response = await GET(request(authorization))
    expect(response.status).toBe(401)
    expect(mocks.createServiceClient).not.toHaveBeenCalled()
  })

  it('fails closed when the cron secret is not configured', async () => {
    vi.stubEnv('CRON_SECRET', '')
    expect((await GET(request())).status).toBe(401)
    expect(mocks.createServiceClient).not.toHaveBeenCalled()
  })

  it('deletes only rows that have reached expiry and reports the count', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { deleted: 3 } })
    expect(mocks.from).toHaveBeenCalledWith('provider_otc')
    expect(mocks.delete).toHaveBeenCalledWith({ count: 'exact' })
    expect(mocks.lte).toHaveBeenCalledWith('expires_at', '2026-09-05T12:00:00.000Z')
  })

  it('succeeds when no rows have expired', async () => {
    mocks.lte.mockResolvedValue({ count: 0, error: null })
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { deleted: 0 } })
  })

  it('reports database failures without exposing their details', async () => {
    mocks.lte.mockResolvedValue({ count: null, error: new Error('private database detail') })
    const response = await GET(request())
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('private database detail')
  })
})
