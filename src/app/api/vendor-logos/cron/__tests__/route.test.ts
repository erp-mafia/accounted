import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))

const runVendorLogos = vi.fn()
vi.mock('@/lib/vendor-logos/run', () => ({ runVendorLogos: (...a: unknown[]) => runVendorLogos(...a) }))

const mock = createTableMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'

const URL = '/api/vendor-logos/cron'
const SUMMARY = { collected: 0, queued: 0, read: null, due: 2, found: 1, missing: 1, blocked: 0, excluded: 0, retry: 0, failed: 0, deferred: 0 }

describe('GET /api/vendor-logos/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.reset()
    delete process.env.VENDOR_LOGOS_FETCH
    runVendorLogos.mockResolvedValue(SUMMARY)
  })

  it('rejects a caller without the cron secret', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(new Response('no', { status: 401 }) as never)
    const res = await GET(createCronRequest(URL))
    expect(res.status).toBe(401)
    expect(runVendorLogos).not.toHaveBeenCalled()
  })

  it('does nothing while VENDOR_LOGOS_FETCH is off', async () => {
    const { status, body } = await parseJsonResponse<{ skipped: boolean }>(await GET(createCronRequest(URL)))
    expect(status).toBe(200)
    expect(body.skipped).toBe(true)
    expect(runVendorLogos).not.toHaveBeenCalled()
    expect(mock.tables()).toEqual([])
  })

  it('runs, collecting on the first run, and answers counts only', async () => {
    process.env.VENDOR_LOGOS_FETCH = 'true'
    mock.setTable('vendor_logos', { data: null, count: 0 })
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(await GET(createCronRequest(URL)))
    expect(status).toBe(200)
    expect(runVendorLogos).toHaveBeenCalledWith(mock.supabase, { collect: true })
    expect(body).toMatchObject({ success: true, collect: true, due: 2, found: 1, missing: 1 })
    expect(body).not.toHaveProperty('read')
  })

  it('only fetches outside the daily collect hour once domains are queued', async () => {
    process.env.VENDOR_LOGOS_FETCH = '1'
    mock.setTable('vendor_logos', { data: null, count: 120 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T10:20:00Z'))
    try {
      await GET(createCronRequest(URL))
      expect(runVendorLogos).toHaveBeenCalledWith(mock.supabase, { collect: false })
      vi.setSystemTime(new Date('2026-10-17T03:20:00Z'))
      await GET(createCronRequest(URL))
      expect(runVendorLogos).toHaveBeenLastCalledWith(mock.supabase, { collect: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers 500 without the error text when the run fails', async () => {
    process.env.VENDOR_LOGOS_FETCH = 'true'
    mock.setTable('vendor_logos', { data: null, count: 5 })
    runVendorLogos.mockRejectedValueOnce(new Error('vendor_logos due read failed'))
    const { status, body } = await parseJsonResponse<Record<string, unknown>>(await GET(createCronRequest(URL)))
    expect(status).toBe(500)
    expect(body).toEqual({ success: false, failed: true })
  })
})
