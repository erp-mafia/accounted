import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest } from '@/tests/helpers'

const sweep = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({}) }))
vi.mock('@/lib/digital-mailboxes/sweep', () => ({ sweepDigitalMailboxes: sweep }))

import { GET } from '../route'

describe('GET /api/digital-mailboxes/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'cron-secret')
  })

  it('returns 401 without the cron secret', async () => {
    const response = await GET(createCronRequest('/api/digital-mailboxes/cron', 'Bearer wrong'))
    expect(response.status).toBe(401)
    expect(sweep).not.toHaveBeenCalled()
  })

  it('runs the sweep and reports its summary', async () => {
    sweep.mockResolvedValue({ connections: 2, activated: 1, filed: 3, failed: 0, deferred: 0, errors: [] })
    const response = await GET(createCronRequest('/api/digital-mailboxes/cron', 'Bearer cron-secret'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { connections: 2, activated: 1, filed: 3, failed: 0, deferred: 0, errors: 0 } })
  })
})
