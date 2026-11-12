import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
const { createServiceRoleClient } = vi.hoisted(() => ({ createServiceRoleClient: vi.fn(() => ({ marker: 'service' })) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient }))
vi.mock('@/lib/cron/watch', () => ({ watchCronRuns: vi.fn() }))

import { verifyCronSecret } from '@/lib/auth/cron'
import { watchCronRuns } from '@/lib/cron/watch'
import { GET, maxDuration } from '../route'

const request = () => new Request('https://app.example.test/api/health/cron-runs/cron')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
})

describe('GET /api/health/cron-runs/cron', () => {
  it('rejects a caller without the cron secret before reading anything', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(watchCronRuns).not.toHaveBeenCalled()
  })

  it('runs the watch with the service-role client and returns what it found', async () => {
    const result = { timedOut: 1, missed: 0, expected: 0, pgCronFailed: 0, reportedJobs: 1, reportedRuns: 1, quietJobs: 0, mailed: true, pruned: 0, errors: 0 }
    vi.mocked(watchCronRuns).mockResolvedValueOnce(result)

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: result })
    expect(vi.mocked(watchCronRuns).mock.calls[0]![0]).toEqual({ marker: 'service' })
  })

  it('answers 500 when the watch itself throws, so its own run is recorded as failed', async () => {
    vi.mocked(watchCronRuns).mockRejectedValueOnce(new Error('boom'))

    expect((await GET(request())).status).toBe(500)
  })

  it('declares a limit', () => {
    expect(maxDuration).toBe(60)
  })
})
