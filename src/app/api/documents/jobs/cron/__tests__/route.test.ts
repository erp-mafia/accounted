import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/documents/jobs/queue', () => ({ runDocumentJobs: vi.fn(), enqueueMissingExtractions: vi.fn() }))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { enqueueMissingExtractions, runDocumentJobs } from '@/lib/documents/jobs/queue'

const call = () => GET(new Request('http://localhost/api/documents/jobs/cron'))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'key'
})

describe('GET /api/documents/jobs/cron', () => {
  it('rejects a request without the cron secret', async () => {
    ;(verifyCronSecret as ReturnType<typeof vi.fn>).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await parseJsonResponse(await call())).status).toBe(401)
    expect(runDocumentJobs).not.toHaveBeenCalled()
  })

  it('tops up extraction jobs, runs one claimed batch within the time budget and reports it', async () => {
    ;(enqueueMissingExtractions as ReturnType<typeof vi.fn>).mockResolvedValue(2)
    ;(runDocumentJobs as ReturnType<typeof vi.fn>).mockResolvedValue({ claimed: 3, done: 2, failed: 1, returned: 0 })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, backfilled: 2, claimed: 3, done: 2, failed: 1, returned: 0 })
    expect(enqueueMissingExtractions).toHaveBeenCalledWith({ tag: 'service' }, 20)
    expect(runDocumentJobs).toHaveBeenCalledWith({ tag: 'service' }, expect.objectContaining({ limit: 8, budgetMs: 180_000 }))
  })

  it('answers 500 when the queue cannot be claimed', async () => {
    ;(enqueueMissingExtractions as ReturnType<typeof vi.fn>).mockResolvedValue(0)
    ;(runDocumentJobs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('claim failed: boom'))
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(500)
    expect(body).toMatchObject({ ok: false })
  })
})
