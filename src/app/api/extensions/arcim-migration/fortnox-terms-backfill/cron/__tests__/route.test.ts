import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: vi.fn() } }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn().mockReturnValue(null) }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('@/extensions/general/arcim-migration/lib/backfill-fortnox-terms', () => ({ runFortnoxTermsBackfill: vi.fn() }))
import { GET, maxDuration } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { verifyCronSecret } from '@/lib/auth/cron'
import { runFortnoxTermsBackfill } from '@/extensions/general/arcim-migration/lib/backfill-fortnox-terms'

const request = () => new Request('http://localhost/api/extensions/arcim-migration/fortnox-terms-backfill/cron')

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  vi.mocked(extensionRegistry.get).mockResolvedValue({ id: 'arcim-migration' } as never)
})
afterEach(() => vi.useRealTimers())

describe('fortnox terms backfill cron', () => {
  it('refuses an unauthenticated invocation before doing work', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({}, { status: 401 }))
    expect((await GET(request())).status).toBe(401)
    expect(runFortnoxTermsBackfill).not.toHaveBeenCalled()
  })

  it('answers 200 skipped for a disabled extension', async () => {
    vi.mocked(extensionRegistry.get).mockResolvedValue(undefined)
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(runFortnoxTermsBackfill).not.toHaveBeenCalled()
  })

  it('runs within 240 s of the start and answers the summary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const summary = { pending: 3, worked: 2, finished: 1, filled: 40 }
    vi.mocked(runFortnoxTermsBackfill).mockResolvedValue(summary)
    const response = await GET(request())
    expect(maxDuration).toBe(300)
    expect(runFortnoxTermsBackfill).toHaveBeenCalledWith(expect.anything(), start + 240_000)
    expect(await response.json()).toEqual({ data: summary })
  })

  it('surfaces a failure instead of an empty successful run', async () => {
    vi.mocked(runFortnoxTermsBackfill).mockRejectedValue(new Error('database unavailable'))
    expect((await GET(request())).status).toBe(500)
  })
})
