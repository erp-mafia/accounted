import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => mockSupabase) }))
vi.mock('@/lib/arkiv/agreements/observe', () => ({ observeObligations: vi.fn() }))
vi.mock('@/lib/documents/jobs/queue', () => ({ enqueueDocumentJob: vi.fn() }))
vi.mock('@/lib/arkiv/facts/derive-company', () => ({ deriveCompanyFacts: vi.fn(async () => ({ recorded: 3, retired: 1, predicates: ['revenue_12m'] })) }))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { observeObligations } from '@/lib/arkiv/agreements/observe'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'

const call = () => GET(new Request('http://localhost/api/arkiv/derive/cron'))
const weekAgo = new Date(Date.now() - 8 * 86_400_000).toISOString()
const yesterday = new Date(Date.now() - 86_400_000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'key'
  process.env.ARKIV_BRAIN_COMPANY_IDS = 'co-1'
})

afterEach(() => {
  delete process.env.ARKIV_BRAIN_COMPANY_IDS
})

describe('GET /api/arkiv/derive/cron', () => {
  it('rejects a request without the cron secret', async () => {
    ;(verifyCronSecret as ReturnType<typeof vi.fn>).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await parseJsonResponse(await call())).status).toBe(401)
    expect(observeObligations).not.toHaveBeenCalled()
  })

  it('observes every company in the rollout and re-queues agreements older than a week', async () => {
    enqueue({
      data: [
        { company_id: 'co-1', source_document_id: 'doc-old', derived_at: weekAgo },
        { company_id: 'co-1', source_document_id: 'doc-fresh', derived_at: yesterday },
        { company_id: 'co-outside', source_document_id: 'doc-x', derived_at: weekAgo },
      ],
    })
    ;(observeObligations as ReturnType<typeof vi.fn>).mockResolvedValue({ checked: 3, matched: 1, missed: 1 })
    ;(enqueueDocumentJob as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, companies: 1, checked: 3, matched: 1, missed: 1, rederived: 1, facts: { companies: 1, recorded: 3, retired: 1, failed: 0 } })
    expect(observeObligations).toHaveBeenCalledTimes(1)
    expect(observeObligations).toHaveBeenCalledWith(mockSupabase, 'co-1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    expect(enqueueDocumentJob).toHaveBeenCalledTimes(1)
    expect(enqueueDocumentJob).toHaveBeenCalledWith(mockSupabase, 'co-1', 'doc-old', 'derive')
  })

  it('answers 500 when the agreements cannot be read', async () => {
    enqueue({ error: { message: 'boom' } })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(500)
    expect(body).toMatchObject({ ok: false })
  })
})
