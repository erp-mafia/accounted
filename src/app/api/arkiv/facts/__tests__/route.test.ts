import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const call = (qs = '?subject_kind=company') => GET(new Request(`http://localhost/api/arkiv/facts${qs}`), {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/facts', () => {
  it('needs a subject id for anything but the company', async () => {
    expect((await parseJsonResponse(await call('?subject_kind=agreement'))).status).toBe(400)
    expect((await parseJsonResponse(await call('?subject_kind=car'))).status).toBe(400)
  })

  it('returns the live facts with their document and how many readings they replaced', async () => {
    enqueue({
      data: [
        { id: 'f2', predicate: 'vat_period', value_text: 'kvartal', valid_from: '2026-01-01', valid_to: null, sys_from: '2026-09-15', sys_to: null, rank: 'normal', status: 'confirmed', source_kind: 'agent', source_document_id: 'doc-1', sources: [{ document_id: 'doc-1', page: 1, quote: 'kvartal' }] },
        { id: 'f1', predicate: 'vat_period', value_text: 'helt beskattningsår', valid_from: null, valid_to: null, sys_from: '2026-09-01', sys_to: '2026-09-15', rank: 'normal', status: 'confirmed', source_kind: 'extraction', source_document_id: 'doc-1', sources: [] },
        { id: 'f0', predicate: 'f_skatt', value_text: 'approved', valid_from: '2025-11-07', valid_to: null, sys_from: '2026-09-01', sys_to: null, rank: 'deprecated', status: 'confirmed', source_kind: 'extraction', source_document_id: null, sources: [] },
      ],
    })
    enqueue({ data: [{ id: 'doc-1', file_name: 'registerutdrag.jpg' }] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({
      data: [{ fact_id: 'f2', predicate: 'vat_period', label: 'Momsperiod', value_text: 'kvartal', valid_from: '2026-01-01', valid_to: null, sys_from: '2026-09-15', source_kind: 'agent', source: { document_id: 'doc-1', file_name: 'registerutdrag.jpg', page: 1, quote: 'kvartal' }, earlier_readings: 1 }],
    })
  })
})
