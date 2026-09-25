import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/documents/extract/store', () => ({ recordHumanFields: vi.fn() }))
vi.mock('@/lib/documents/jobs/queue', () => ({ enqueueDocumentJob: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { recordHumanFields } from '@/lib/documents/extract/store'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const call = (body: unknown) =>
  POST(
    new Request(`http://localhost/api/documents/${DOC}/extraction/fields`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: DOC }) } as never,
  )
const settle = (outcome: unknown) => (recordHumanFields as ReturnType<typeof vi.fn>).mockResolvedValue(outcome)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('POST /api/documents/[id]/extraction/fields', () => {
  it('rejects an empty field map and values that are not scalars', async () => {
    expect((await parseJsonResponse(await call({ fields: {} }))).status).toBe(400)
    expect((await parseJsonResponse(await call({ fields: { principal: { nested: true } } }))).status).toBe(400)
  })

  it('returns 404 for a document that is not the company\'s', async () => {
    enqueue({ data: null })
    expect((await parseJsonResponse(await call({ fields: { interest_rate: 11.1 } }))).status).toBe(404)
    expect(recordHumanFields).not.toHaveBeenCalled()
  })

  it('records the person\'s values on top of the current record', async () => {
    enqueue({ data: { id: DOC } })
    settle({ status: 'extracted', extractionId: 'ext-2', schemaType: 'agreement.loan', reviewFields: [] })
    const { status, body } = await parseJsonResponse(await call({ fields: { interest_rate: '11,10', security: null } }))
    expect(status).toBe(200)
    expect(body).toEqual({ data: { document_id: DOC, extraction_id: 'ext-2', review_fields: [] } })
    expect(recordHumanFields).toHaveBeenCalledWith({ tag: 'service' }, DOC, 'user-1', { interest_rate: '11,10', security: null })
    expect(enqueueDocumentJob).toHaveBeenCalledWith({ tag: 'service' }, 'company-1', DOC, 'derive')
  })

  it('does not queue a derivation for a record without facts or an agreement', async () => {
    enqueue({ data: { id: DOC } })
    settle({ status: 'extracted', extractionId: 'ext-3', schemaType: 'generic', reviewFields: [] })
    expect((await parseJsonResponse(await call({ fields: { key_terms: null } }))).status).toBe(200)
    expect(enqueueDocumentJob).not.toHaveBeenCalled()
  })

  it('answers 404 without a record, 400 for a field outside the schema, and 500 without internals', async () => {
    enqueue({ data: { id: DOC } })
    settle({ status: 'skipped', reason: 'no_extraction' })
    expect((await parseJsonResponse(await call({ fields: { interest_rate: 11.1 } }))).status).toBe(404)

    enqueue({ data: { id: DOC } })
    settle({ status: 'skipped', reason: 'unknown_fields' })
    expect((await parseJsonResponse(await call({ fields: { shoe_size: 44 } }))).status).toBe(400)

    enqueue({ data: { id: DOC } })
    settle({ status: 'error', reason: 'extraction save failed: permission denied' })
    const { status, body } = await parseJsonResponse(await call({ fields: { interest_rate: 11.1 } }))
    expect(status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('permission denied')
  })
})
