import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('@/lib/payments/orders/sync', () => ({ syncPaymentOrderStatuses: vi.fn() }))
vi.mock('@/lib/payments/orders/verification-sweep', () => ({ sweepPaymentVerifications: vi.fn() }))

import { verifyCronSecret } from '@/lib/auth/cron'
import { syncPaymentOrderStatuses } from '@/lib/payments/orders/sync'
import { sweepPaymentVerifications } from '@/lib/payments/orders/verification-sweep'
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
    expect(sweepPaymentVerifications).not.toHaveBeenCalled()
  })

  it('runs the status sync, then the verification sweep, and returns both summaries', async () => {
    const summary = { checked: 3, moved: 1, markedUnknown: 0, released: 0, abandoned: 1, signedLate: 0, cancelledForClosedInvoice: 1, heldForPerson: 0, settledByDebit: 0, linkedByDebit: 0, forgottenIps: 0, errors: 0 }
    const verifications = { considered: 2, refreshed: 2, renewalDue: 1, skipped: { doorClosed: 0, noOrgNumber: 0 }, errors: 0 }
    vi.mocked(syncPaymentOrderStatuses).mockResolvedValueOnce(summary)
    vi.mocked(sweepPaymentVerifications).mockResolvedValueOnce(verifications)

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { ...summary, verifications } })
    // Both passes write with the same service-role client.
    expect(vi.mocked(sweepPaymentVerifications).mock.calls[0]![0]).toBe(vi.mocked(syncPaymentOrderStatuses).mock.calls[0]![0])
  })
})
