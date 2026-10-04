import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('@/lib/payments/orders/sync', () => ({ syncPaymentOrderStatuses: vi.fn() }))

import { verifyCronSecret } from '@/lib/auth/cron'
import { syncPaymentOrderStatuses } from '@/lib/payments/orders/sync'
import { GET } from '../route'

function request(): Request {
  return new Request('https://app.accounted.se/api/payments/orders/status/cron')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
})

describe('GET /api/payments/orders/status/cron', () => {
  it('rejects a caller without the cron secret before reading anything', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(syncPaymentOrderStatuses).not.toHaveBeenCalled()
  })

  it('runs the status sync and returns its summary', async () => {
    const summary = { checked: 3, moved: 1, failedStale: 0, abandoned: 1, signedLate: 0, errors: 0 }
    vi.mocked(syncPaymentOrderStatuses).mockResolvedValueOnce(summary)

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: summary })
  })
})
