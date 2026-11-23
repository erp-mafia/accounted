import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => mockSupabase) }))
vi.mock('@/lib/documents/jobs/queue', () => ({ runDocumentJobFor: vi.fn() }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { runDocumentJobFor } from '@/lib/documents/jobs/queue'
import { currentAiDeadline } from '@/lib/ai/call-limit'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const call = (query = '') => GET(new Request(`http://localhost/api/documents/${DOC}/pipeline${query}`), { params: Promise.resolve({ id: DOC }) } as never)
const document = (over: Record<string, unknown> = {}) => ({ id: DOC, file_name: 'IMG_1.jpg', doc_type: null, admission_state: 'admitted', journal_entry_id: null, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  delete process.env.ARKIV_BRAIN_COMPANY_IDS
  delete process.env.INKORG_V2_COMPANY_IDS
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/documents/[id]/pipeline', () => {
  it("is 404 for another company's document", async () => {
    enqueue({ data: null })
    expect((await parseJsonResponse(await call())).status).toBe(404)
  })

  it('reports the stage while reading, and never advances unless asked', async () => {
    enqueue({ data: { id: DOC } })
    enqueue({ data: document() })
    enqueue({ data: [{ kind: 'read', status: 'running', attempts: 1, max_attempts: 5, last_error: null }] })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toMatchObject({ data: { stage: 'reading', steps: { read: 'running', classify: 'none' }, landed: null, title: 'IMG_1' } })
    expect(runDocumentJobFor).not.toHaveBeenCalled()
  })

  it('advances one step on request and says where a receipt landed', async () => {
    enqueue({ data: { id: DOC } })
    enqueue({ data: document({ doc_type: 'receipt' }) })
    enqueue({
      data: [
        { kind: 'read', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
        { kind: 'classify', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
        { kind: 'extract', status: 'queued', attempts: 0, max_attempts: 5, last_error: null },
      ],
    })
    enqueue({ data: { payload: { merchant_name: { value: 'Balzac', normalized: 'Balzac' } } } })
    enqueue({ data: null })
    enqueue({ data: { id: 'item-1', matched_transaction_id: 'tx-1', routed_to_arkiv_at: null } })
    const { body } = await parseJsonResponse(await call('?advance=1'))
    expect(runDocumentJobFor).toHaveBeenCalledWith(mockSupabase, DOC, 'pipeline:user-1')
    expect(body).toMatchObject({ data: { stage: 'landing', title: 'Kvitto Balzac', landed: { kind: 'underlag', href: '/e/general/invoice-inbox', matched: true } } })
  })

  it('says a receipt landed in the new inbox page for a company in its rollout, and in the workspace for any other', async () => {
    const landedHref = async () => {
      enqueue({ data: { id: DOC } })
      enqueue({ data: document({ doc_type: 'receipt' }) })
      enqueue({
        data: [
          { kind: 'read', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
          { kind: 'classify', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
        ],
      })
      enqueue({ data: null })
      enqueue({ data: null })
      enqueue({ data: null })
      const { body } = await parseJsonResponse<{ data: { landed: { kind: string; href: string } | null } }>(await call())
      return body.data.landed
    }
    process.env.INKORG_V2_COMPANY_IDS = 'company-1'
    expect(await landedHref()).toMatchObject({ kind: 'underlag', href: '/inkorg' })
    process.env.INKORG_V2_COMPANY_IDS = 'company-2'
    expect(await landedHref()).toMatchObject({ kind: 'underlag', href: '/e/general/invoice-inbox' })
  })

  it('ends the model calls of an advanced step before the function is killed: one call\'s own limit is twice the minute this route has', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    let modelStop: number | undefined
    ;(runDocumentJobFor as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      modelStop = currentAiDeadline()
      return null
    })
    enqueue({ data: { id: DOC } })
    enqueue({ data: document() })
    enqueue({ data: [{ kind: 'read', status: 'failed', attempts: 1, max_attempts: 5, last_error: "reader_unavailable: Request timed out: the run's time was up 44 s into the model call" }] })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: null })
    try {
      const { status, body } = await parseJsonResponse(await call('?advance=1'))
      expect(status).toBe(200)
      // A step cut by the clock with attempts left is still on its way: the worker has it.
      expect(body).toMatchObject({ data: { stage: 'reading', steps: { read: 'queued' } } })
    } finally {
      clock.mockRestore()
    }
    // 45 s into a 60 s function.
    expect(modelStop).toBe(1_045_000)
  })

  it('outside the brain, an untyped document and an agreement land on the document page, where the type is set', async () => {
    enqueue({ data: { id: DOC } })
    enqueue({ data: document({ doc_type: 'other' }) })
    enqueue({
      data: [
        { kind: 'read', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
        { kind: 'classify', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
      ],
    })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: null })
    expect((await parseJsonResponse(await call())).body).toMatchObject({
      data: { stage: 'landed', landed: { kind: 'review', href: `/arkiv/dokument/${DOC}` } },
    })

    enqueue({ data: { id: DOC } })
    enqueue({ data: document({ doc_type: 'agreement.loan' }) })
    enqueue({
      data: [
        { kind: 'read', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
        { kind: 'classify', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
      ],
    })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: null })
    expect((await parseJsonResponse(await call())).body).toMatchObject({
      data: { stage: 'landed', landed: { kind: 'document', href: `/arkiv/dokument/${DOC}` } },
    })
  })

  it('in the brain, says an agreement landed on its own page, and a document nobody could read failed', async () => {
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
    enqueue({ data: { id: DOC } })
    enqueue({ data: document({ doc_type: 'agreement.loan' }) })
    enqueue({
      data: [
        { kind: 'read', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
        { kind: 'classify', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
        { kind: 'extract', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
        { kind: 'derive', status: 'done', attempts: 1, max_attempts: 5, last_error: null },
      ],
    })
    enqueue({ data: null })
    enqueue({ data: { id: 'agr-1', title: 'Lån 500050956' } })
    enqueue({ data: null })
    expect((await parseJsonResponse(await call())).body).toMatchObject({
      data: { stage: 'landed', title: 'Lån 500050956', landed: { kind: 'agreement', href: '/arkiv/avtal/agr-1', label: 'Lån 500050956' } },
    })

    enqueue({ data: { id: DOC } })
    enqueue({ data: document() })
    enqueue({ data: [{ kind: 'read', status: 'failed', attempts: 5, max_attempts: 5, last_error: 'download_failed: Object not found' }] })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: null })
    expect((await parseJsonResponse(await call())).body).toMatchObject({ data: { stage: 'failed', steps: { read: 'failed' }, error: 'download_failed: Object not found' } })
  })
})
