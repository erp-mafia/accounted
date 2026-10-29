import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => mockSupabase) }))
vi.mock('@/lib/arkiv/agreements/observe', () => ({ observeObligations: vi.fn() }))
vi.mock('@/lib/documents/jobs/queue', () => ({ enqueueDocumentJob: vi.fn() }))
vi.mock('@/lib/arkiv/facts/derive-company', () => ({ deriveCompanyFacts: vi.fn(async () => ({ recorded: 3, retired: 1, predicates: ['revenue_12m'] })) }))
vi.mock('@/lib/commitments/agreements', () => ({ refreshManualAgreements: vi.fn() }))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { observeObligations } from '@/lib/arkiv/agreements/observe'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { refreshManualAgreements } from '@/lib/commitments/agreements'

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
  delete process.env.BOLAGET_COMPANY_IDS
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

  it('reads agreements past the 1000-row page, so a rollout company on the second page is observed', async () => {
    enqueue({ data: Array.from({ length: 1000 }, (_, i) => ({ company_id: 'co-outside', source_document_id: `doc-${i}`, derived_at: yesterday })) })
    enqueue({ data: [{ company_id: 'co-1', source_document_id: 'doc-late', derived_at: yesterday }] })
    ;(observeObligations as ReturnType<typeof vi.fn>).mockResolvedValue({ checked: 0, matched: 0, missed: 0 })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toMatchObject({ companies: 1 })
    expect(observeObligations).toHaveBeenCalledWith(mockSupabase, 'co-1', expect.any(String))
  })

  it('answers 500 when the agreements cannot be read', async () => {
    enqueue({ error: { message: 'boom' } })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(500)
    expect(body).toMatchObject({ ok: false })
  })

  it('leaves the manual agreements alone while the Bolaget rollout names nobody', async () => {
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('manual')
    expect(refreshManualAgreements).not.toHaveBeenCalled()
  })

  it('refreshes the manual agreements of rollout companies and observes them unless the brain pass did', async () => {
    process.env.BOLAGET_COMPANY_IDS = 'co-1,co-2'
    // The brain's documents' agreements: co-1 only.
    enqueue({ data: [{ company_id: 'co-1', source_document_id: 'doc-fresh', derived_at: yesterday }] })
    // Active manual agreements: co-1, co-2 and a company outside the rollout.
    enqueue({ data: [{ company_id: 'co-1' }, { company_id: 'co-2' }, { company_id: 'co-2' }, { company_id: 'co-outside' }] })
    ;(observeObligations as ReturnType<typeof vi.fn>).mockResolvedValue({ checked: 2, matched: 1, missed: 0 })
    ;(refreshManualAgreements as ReturnType<typeof vi.fn>).mockImplementation(async (_s: unknown, companyId: string) => ({
      agreementIds: [`${companyId}-a`],
      refreshed: 1,
    }))
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect((body as { manual: unknown }).manual).toEqual({ companies: 2, refreshed: 2, checked: 2, matched: 1, missed: 0, failed: 0 })
    expect(refreshManualAgreements).toHaveBeenCalledTimes(2)
    // co-1 was observed whole by the brain pass; co-2 only for its manual agreements.
    expect(observeObligations).toHaveBeenCalledTimes(2)
    expect(observeObligations).toHaveBeenCalledWith(mockSupabase, 'co-2', expect.any(String), { agreementIds: ['co-2-a'] })
  })

  it('keeps the brain result when the manual agreements cannot be read', async () => {
    process.env.BOLAGET_COMPANY_IDS = '*'
    enqueue({ data: [{ company_id: 'co-1', source_document_id: 'doc-old', derived_at: weekAgo }] })
    enqueue({ error: { message: 'column agreements.origin does not exist' } })
    ;(observeObligations as ReturnType<typeof vi.fn>).mockResolvedValue({ checked: 1, matched: 0, missed: 0 })
    ;(enqueueDocumentJob as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, companies: 1, rederived: 1, manual: { companies: 0, refreshed: 0 } })
  })
})
