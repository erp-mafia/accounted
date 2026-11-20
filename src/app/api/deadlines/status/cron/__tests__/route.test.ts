import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest, createQueuedMockSupabase } from '@/tests/helpers'

const db = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: () => db.client }))

import { GET } from '../route'

const PATH = '/api/deadlines/status/cron'

describe('GET /api/deadlines/status/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'cron-secret')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role')
  })

  it('returns 401 without the cron secret', async () => {
    const response = await GET(createCronRequest(PATH, 'Bearer wrong'))
    expect(response.status).toBe(401)
  })

  it('answers the counts when both updates succeed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'd1' }] })
    enqueue({ data: [{ id: 'd2' }, { id: 'd3' }] })
    db.client = supabase

    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, updated: 3, newlyOverdue: 1, newlyActionNeeded: 2 })
  })

  it('answers an error when an update failed: a run that moved nothing must not look like a quiet day', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'canceling statement due to statement timeout' } })
    enqueue({ data: [] })
    db.client = supabase

    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(response.status).toBeGreaterThanOrEqual(500)
  })
})
