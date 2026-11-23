import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/documents/jobs/queue', () => ({ runDocumentJobs: vi.fn(), enqueueMissingExtractions: vi.fn() }))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { enqueueMissingExtractions, runDocumentJobs } from '@/lib/documents/jobs/queue'
import { currentAiDeadline } from '@/lib/ai/call-limit'

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

  it('tops up extraction jobs, runs the due jobs within the time budget and reports it', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    ;(enqueueMissingExtractions as ReturnType<typeof vi.fn>).mockResolvedValue(2)
    let modelStop: number | undefined
    ;(runDocumentJobs as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      modelStop = currentAiDeadline()
      return { claimed: 3, done: 2, failed: 1 }
    })
    try {
      const { status, body } = await parseJsonResponse(await call())
      expect(status).toBe(200)
      expect(body).toEqual({ ok: true, backfilled: 2, claimed: 3, done: 2, failed: 1 })
    } finally {
      clock.mockRestore()
    }
    expect(enqueueMissingExtractions).toHaveBeenCalledWith({ tag: 'service' }, 20)
    // Counted from when the request arrived: no job is claimed after 180 s, no model call is open after 280 s.
    expect(runDocumentJobs).toHaveBeenCalledWith({ tag: 'service' }, expect.objectContaining({ deadlineAt: 1_180_000 }))
    // The time is the only stop: a cap of 8 a run held every company's documents behind one import (crm#2166).
    expect((runDocumentJobs as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty('limit')
    expect(modelStop).toBe(1_280_000)
  })

  it('runs the queue when the extraction top-up fails: one failing RPC used to stop every claim', async () => {
    ;(enqueueMissingExtractions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('extraction backfill failed: boom'))
    ;(runDocumentJobs as ReturnType<typeof vi.fn>).mockResolvedValue({ claimed: 2, done: 2, failed: 0 })
    const { status, body } = await parseJsonResponse(await call())
    expect(runDocumentJobs).toHaveBeenCalledTimes(1)
    // The jobs ran and are reported; the run still answers as failed, since it did not do all of its work.
    expect(status).toBe(500)
    expect(body).toMatchObject({ ok: false, backfilled: null, claimed: 2, done: 2, failed: 0 })
  })

  it('answers 500 when the queue cannot be claimed', async () => {
    ;(enqueueMissingExtractions as ReturnType<typeof vi.fn>).mockResolvedValue(0)
    ;(runDocumentJobs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('claim failed: boom'))
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(500)
    expect(body).toMatchObject({ ok: false })
  })
})
