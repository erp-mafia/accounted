/**
 * GET /api/reminders/batch/cron: the cron secret, and the day's run handed to
 * runReminderBatchCron (tested with lib/reminders/gather.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCronRequest, parseJsonResponse } from '@/tests/helpers'

const runMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reminders/gather', () => ({ runReminderBatchCron: runMock }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'

const SUMMARY = { enabled: true, companies: 2, staged: 1, empty: 1, pendingExists: 0, alreadyStaged: 0, noOwner: 0, withdrawn: 0, failed: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', 'secret')
  runMock.mockResolvedValue(SUMMARY)
})

describe('GET /api/reminders/batch/cron', () => {
  it('refuses a call without the cron secret', async () => {
    expect((await GET(createCronRequest('/api/reminders/batch/cron'))).status).toBe(401)
    expect((await GET(createCronRequest('/api/reminders/batch/cron', 'Bearer wrong'))).status).toBe(401)
    expect(runMock).not.toHaveBeenCalled()
  })

  it("stages the day's batches and answers the summary", async () => {
    const res = await GET(createCronRequest('/api/reminders/batch/cron', 'Bearer secret'))
    expect(res.status).toBe(200)
    expect((await parseJsonResponse<{ data: unknown }>(res)).body.data).toEqual(SUMMARY)
    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it('answers 500 when the run fails', async () => {
    runMock.mockRejectedValue(new Error('database down'))
    expect((await GET(createCronRequest('/api/reminders/batch/cron', 'Bearer secret'))).status).toBe(500)
  })
})
