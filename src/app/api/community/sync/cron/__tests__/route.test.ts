import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({ service: true })) }))
vi.mock('@/lib/agent-skills/community-sync', () => ({ syncCommunityFromRepo: vi.fn() }))
vi.mock('@/lib/agent-skills/community-notify', () => ({ notifyPublishedAuthors: vi.fn() }))

import { verifyCronSecret } from '@/lib/auth/cron'
import { syncCommunityFromRepo } from '@/lib/agent-skills/community-sync'
import { notifyPublishedAuthors } from '@/lib/agent-skills/community-notify'
import { GET } from '../route'

const request = () => new Request('https://app.accounted.se/api/community/sync/cron')
const synced = { published: [], updated: [], deactivated: [], linked: ['sub-1'], pending: [], withdrawn: [], skipped: [] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  vi.mocked(syncCommunityFromRepo).mockResolvedValue(synced)
  vi.mocked(notifyPublishedAuthors).mockResolvedValue({ notified: ['sub-1'], waiting: [], failed: [] })
})

describe('community sync cron', () => {
  it('refuses a call without the cron secret', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await GET(request())).status).toBe(401)
    expect(syncCommunityFromRepo).not.toHaveBeenCalled()
  })

  it('syncs the repository, then tells authors whose page is live', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(syncCommunityFromRepo).toHaveBeenCalledWith({ service: true })
    expect(notifyPublishedAuthors).toHaveBeenCalledWith({ service: true })
    expect(vi.mocked(syncCommunityFromRepo).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(notifyPublishedAuthors).mock.invocationCallOrder[0])
    expect((await response.json()).data).toMatchObject({ linked: ['sub-1'], notified: { notified: ['sub-1'] } })
  })
})
