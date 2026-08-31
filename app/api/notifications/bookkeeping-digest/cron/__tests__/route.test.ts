/**
 * The cron shell around the digest: authorization and summary aggregation.
 * The digest logic itself is covered by
 * lib/notifications/__tests__/bookkeeping-digest.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({})),
}))

const mockRunDigest = vi.fn()
vi.mock('@/lib/notifications/bookkeeping-digest', () => ({
  runBookkeepingDigest: (...args: unknown[]) => mockRunDigest(...args),
}))

import { verifyCronSecret } from '@/lib/auth/cron'
import { createServiceClient } from '@/lib/supabase/server'
import { GET } from '../route'

function request(): Request {
  return new Request('https://app.testbrand.example/api/notifications/bookkeeping-digest/cron')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
})

describe('GET /api/notifications/bookkeeping-digest/cron', () => {
  it('rejects an unauthorized caller without touching the database', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled()
    expect(mockRunDigest).not.toHaveBeenCalled()
  })

  it('runs the digest and returns its summary', async () => {
    mockRunDigest.mockResolvedValueOnce({
      optedInUsers: 2,
      companiesConsidered: 1,
      sent: 2,
      skippedEmpty: 0,
      skippedDuplicate: 0,
      failed: 0,
    })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, sent: 2, optedInUsers: 2 })
    expect(mockRunDigest).toHaveBeenCalledTimes(1)
    expect(mockRunDigest.mock.calls[0][1]).toBeInstanceOf(Date)
  })

  it('maps a thrown digest failure to the canonical error envelope', async () => {
    mockRunDigest.mockRejectedValueOnce(new Error('boom'))

    const response = await GET(request())

    expect(response.status).toBeGreaterThanOrEqual(500)
    const body = await response.json()
    expect(body.error).toBeDefined()
  })
})
