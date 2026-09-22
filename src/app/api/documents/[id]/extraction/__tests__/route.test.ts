import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const call = () => GET(new Request(`http://localhost/api/documents/${DOC}/extraction`), { params: Promise.resolve({ id: DOC }) } as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/documents/[id]/extraction', () => {
  it('is 404 outside the rollout', async () => {
    process.env.ARKIV_COMPANY_IDS = 'someone-else'
    expect((await parseJsonResponse(await call())).status).toBe(404)
  })

  it('is 404 before the first extraction, and reads only the company\'s current record', async () => {
    enqueue({ data: null })
    expect((await parseJsonResponse(await call())).status).toBe(404)
    expect(findCalls('document_extractions', 'eq')).toEqual([['document_id', DOC], ['company_id', 'company-1'], ['is_current', true]])
  })

  it('returns the current record with the schema\'s field definitions', async () => {
    enqueue({
      data: {
        id: 'ext-1',
        document_id: DOC,
        schema_type: 'agreement.loan',
        schema_version: 1,
        pass: 'consensus',
        payload: { principal: { value: 1000000, normalized: 1000000, page: 1, quote: null, bbox: null, confidence: 1, method: 'consensus', readings: [] } },
        validation: [],
        review_fields: ['interest_rate'],
        created_at: '2026-09-15T08:00:00Z',
      },
    })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    const data = (body as { data: { extraction_id: string; review_fields: string[]; fields: Array<{ name: string }> } }).data
    expect(data).toMatchObject({ extraction_id: 'ext-1', review_fields: ['interest_rate'] })
    expect(data).not.toHaveProperty('id')
    expect(data.fields.map((f) => f.name)).toContain('principal')
  })
})
