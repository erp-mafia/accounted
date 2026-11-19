import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest } from '@/tests/helpers'

const sweep = vi.hoisted(() => vi.fn())
const checkSenders = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({}) }))
vi.mock('@/lib/digital-mailboxes/sweep', () => ({ sweepDigitalMailboxes: sweep }))
vi.mock('@/lib/digital-mailboxes/connect', () => ({ checkPendingSenderRequests: checkSenders }))

import { GET } from '../route'

describe('GET /api/digital-mailboxes/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'cron-secret')
    checkSenders.mockResolvedValue({ checked: 0, activated: 0, rejected: 0, errors: [] })
  })

  it('returns 401 without the cron secret', async () => {
    const response = await GET(createCronRequest('/api/digital-mailboxes/cron', 'Bearer wrong'))
    expect(response.status).toBe(401)
    expect(sweep).not.toHaveBeenCalled()
    expect(checkSenders).not.toHaveBeenCalled()
  })

  it('runs the sweep and reports its summary', async () => {
    sweep.mockResolvedValue({ connections: 2, activated: 1, filed: 3, failed: 0, deferred: 0, errors: [] })
    const response = await GET(createCronRequest('/api/digital-mailboxes/cron', 'Bearer cron-secret'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        connections: 2,
        activated: 1,
        filed: 3,
        failed: 0,
        deferred: 0,
        errors: 0,
        sender_requests: { checked: 0, activated: 0, rejected: 0, errors: 0 },
      },
    })
  })

  it('asks about sender access requests that wait for the provider, after the sweep', async () => {
    sweep.mockResolvedValue({ connections: 0, activated: 0, filed: 0, failed: 0, deferred: 0, errors: [] })
    checkSenders.mockResolvedValue({ checked: 3, activated: 1, rejected: 0, errors: [{ companyId: 'c', provider: 'kivra', reason: 'x' }] })
    const response = await GET(createCronRequest('/api/digital-mailboxes/cron', 'Bearer cron-secret'))
    expect(response.status).toBe(200)
    expect(checkSenders).toHaveBeenCalledTimes(1)
    expect((await response.json()).data.sender_requests).toEqual({ checked: 3, activated: 1, rejected: 0, errors: 1 })
  })
})
