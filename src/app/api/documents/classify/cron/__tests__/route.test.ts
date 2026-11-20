import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

const from = vi.fn()

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => ({ from })) }))
vi.mock('@/lib/documents/classify/classify', () => ({ classifyUnclassifiedDocuments: vi.fn() }))
vi.mock('@/lib/documents/classify/stale', () => ({ requeueStaleVerdicts: vi.fn(async () => ({ candidates: 0, queued: 0, skipped: 0 })) }))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { classifyUnclassifiedDocuments } from '@/lib/documents/classify/classify'
import { currentAiDeadline } from '@/lib/ai/call-limit'

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>
const request = () => new Request('http://localhost/api/documents/classify/cron')

// The untyped-rows scan, answered with the company ids given.
function scanReturning(companyIds: Array<string | null>) {
  const api: Record<string, unknown> = {}
  for (const m of ['select', 'is', 'not', 'gt', 'order']) api[m] = () => api
  api.limit = () => Promise.resolve({ data: companyIds.map((company_id) => ({ company_id })), error: null })
  from.mockReturnValue(api)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'key'
  asMock(classifyUnclassifiedDocuments).mockResolvedValue({ processed: 2, classified: 2, held: 1, skipped: 0, errors: 0, deferred: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /api/documents/classify/cron', () => {
  it('rejects a request without the cron secret', async () => {
    asMock(verifyCronSecret).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const { status } = await parseJsonResponse(await GET(request()))
    expect(status).toBe(401)
    expect(classifyUnclassifiedDocuments).not.toHaveBeenCalled()
  })



  it('finds the companies from the newest untyped rows: the shelf is on for everyone', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    scanReturning(['co-9', 'co-9', null, 'co-3'])
    await GET(request())
    expect(asMock(classifyUnclassifiedDocuments).mock.calls.map((c) => c[1])).toEqual(['co-9', 'co-3'])
    expect(asMock(classifyUnclassifiedDocuments).mock.calls.map((c) => c[2])).toEqual([10, 10])
  })

  it('hands every batch the run deadline, counted from when the request arrived, so the check sits in front of each document', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    scanReturning(['co-1', 'co-2'])
    await GET(request())
    expect(asMock(classifyUnclassifiedDocuments).mock.calls.map((c) => c[3])).toEqual([{ deadlineAt: 1_200_000 }, { deadlineAt: 1_200_000 }])
  })

  it('stops starting companies at its time budget and counts what it left to the next run', async () => {
    // Each company's batch takes a minute (a provider outage: ~15 s a document); the fourth is cut short by its own deadline check.
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    asMock(classifyUnclassifiedDocuments).mockImplementation(async () => {
      now += 60_000
      return { processed: 4, classified: 0, held: 0, skipped: 0, errors: 4, deferred: now > 1_200_000 ? 6 : 0 }
    })
    scanReturning(['co-1', 'co-2', 'co-3', 'co-4', 'co-5', 'co-6'])

    const { status, body } = await parseJsonResponse<{ processed: number; deferred: number; deferredCompanies: number }>(await GET(request()))

    expect(status).toBe(200)
    // 200 s: batches start at 0, 60, 120 and 180 s; at 240 s nothing more is started.
    expect(asMock(classifyUnclassifiedDocuments).mock.calls.map((c) => c[1])).toEqual(['co-1', 'co-2', 'co-3', 'co-4'])
    expect(body.deferredCompanies).toBe(2)
    expect(body.deferred).toBe(6)
    expect(body.processed).toBe(16)
  })

  it('ends every model call of the run before the function is killed: a call cannot outlive the run', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    scanReturning(['co-1'])
    let modelStop: number | undefined
    asMock(classifyUnclassifiedDocuments).mockImplementation(async () => {
      modelStop = currentAiDeadline()
      return { processed: 1, classified: 1, held: 0, skipped: 0, errors: 0, deferred: 0 }
    })
    await GET(request())
    // 270 s into a 300 s function.
    expect(modelStop).toBe(1_270_000)
  })
})
