import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: vi.fn() } }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn().mockReturnValue(null) }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('@/extensions/general/arcim-migration/lib/fortnox-topup', () => ({ runFortnoxTopups: vi.fn() }))
import { GET, maxDuration } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { verifyCronSecret } from '@/lib/auth/cron'
import { runFortnoxTopups } from '@/extensions/general/arcim-migration/lib/fortnox-topup'

const request = () => new Request('http://localhost/api/extensions/arcim-migration/fortnox-topup/cron')

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  vi.mocked(extensionRegistry.get).mockResolvedValue({ id: 'arcim-migration' } as never)
})
afterEach(() => vi.useRealTimers())

describe('the nightly top-up cron from Fortnox', () => {
  it('refuses an unauthenticated invocation before doing work', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({}, { status: 401 }))
    expect((await GET(request())).status).toBe(401)
    expect(runFortnoxTopups).not.toHaveBeenCalled()
  })

  it('answers 200 skipped for a disabled extension', async () => {
    vi.mocked(extensionRegistry.get).mockResolvedValue(undefined)
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(runFortnoxTopups).not.toHaveBeenCalled()
  })

  it('starts no company after 600 s and cuts one at 760 s, under the 800 s the platform allows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const result = { due: 2, ran: 2, added: 1, nothingNew: 1, failed: 0, stopped: 0, running: 0 }
    vi.mocked(runFortnoxTopups).mockResolvedValue(result)

    const response = await GET(request())

    expect(maxDuration).toBe(800)
    expect(runFortnoxTopups).toHaveBeenCalledWith({ supabase: expect.anything(), deadline: start + 600_000, hardDeadline: start + 760_000 })
    expect(await response.json()).toEqual({ data: result })
  })

  it('surfaces a failure instead of an empty successful run', async () => {
    vi.mocked(runFortnoxTopups).mockRejectedValue(new Error('database unavailable'))
    expect((await GET(request())).status).toBe(500)
  })
})
