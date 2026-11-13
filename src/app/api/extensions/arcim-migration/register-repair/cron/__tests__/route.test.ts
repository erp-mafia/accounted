import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: vi.fn() } }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn().mockReturnValue(null) }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('@/extensions/general/arcim-migration/lib/repair-imported-registers', () => ({ runRegisterRepair: vi.fn() }))
import { GET, maxDuration } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { verifyCronSecret } from '@/lib/auth/cron'
import { runRegisterRepair } from '@/extensions/general/arcim-migration/lib/repair-imported-registers'

const request = () => new Request('http://localhost/api/extensions/arcim-migration/register-repair/cron')

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  vi.mocked(extensionRegistry.get).mockResolvedValue({ id: 'arcim-migration' } as never)
})
afterEach(() => vi.useRealTimers())

describe('register repair cron', () => {
  it('refuses an unauthenticated invocation before doing work', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({}, { status: 401 }))
    expect((await GET(request())).status).toBe(401)
    expect(runRegisterRepair).not.toHaveBeenCalled()
  })

  it('answers 200 skipped for a disabled extension', async () => {
    vi.mocked(extensionRegistry.get).mockResolvedValue(undefined)
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(runRegisterRepair).not.toHaveBeenCalled()
  })

  it('stops starting work 150 s in, half the time the platform allows, and answers the summary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const summary = { pending: 3, worked: 2, finished: 1, changed: 40, errors: 0 }
    vi.mocked(runRegisterRepair).mockResolvedValue(summary)
    const response = await GET(request())
    expect(maxDuration).toBe(300)
    expect(runRegisterRepair).toHaveBeenCalledWith(expect.anything(), start + 150_000)
    expect(await response.json()).toEqual({ data: summary })
  })

  it('answers 200 when one company\'s progress could not be saved and the others\' was', async () => {
    vi.mocked(runRegisterRepair).mockResolvedValue({ pending: 4, worked: 4, finished: 2, changed: 12, errors: 1 })
    expect((await GET(request())).status).toBe(200)
  })

  it('answers 500 when no company\'s progress could be saved: the run did no lasting work', async () => {
    vi.mocked(runRegisterRepair).mockResolvedValue({ pending: 4, worked: 4, finished: 0, changed: 0, errors: 4 })
    expect((await GET(request())).status).toBe(500)
  })

  it('surfaces a failure instead of an empty successful run', async () => {
    vi.mocked(runRegisterRepair).mockRejectedValue(new Error('database unavailable'))
    expect((await GET(request())).status).toBe(500)
  })
})
