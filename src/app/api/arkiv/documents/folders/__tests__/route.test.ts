import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const call = (qs = '') => GET(new Request(`http://localhost/api/arkiv/documents/folders${qs}`), {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/documents/folders', () => {
  it('answers 401 without a session', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await parseJsonResponse(await call())).status).toBe(401)
  })

  it('rejects an out-of-range year', async () => {
    expect((await parseJsonResponse(await call('?year=1999'))).status).toBe(400)
  })

  it('counts every folder over the whole archive, not over a loaded page', async () => {
    // A big archive: counts come from the database, never from the 500 newest rows.
    enqueue({
      data: [
        { doc_type: 'receipt', n: '9120' },
        { doc_type: 'credit_note', n: 12 },
        { doc_type: 'supplier_invoice', n: 4000 },
        { doc_type: 'agreement.loan', n: 2 },
        { doc_type: 'agreement.rental', n: 1 },
        { doc_type: null, n: 1480 },
        { doc_type: 'something_new', n: 3 },
      ],
    })
    const { status, body } = await parseJsonResponse(await call('?year=2025'))
    expect(status).toBe(200)
    const data = (body as { data: { total: number; folders: Array<{ key: string; count: number; types: Array<{ doc_type: string; count: number }> }> } }).data
    expect(data.total).toBe(14618)
    expect(data.folders.map((f) => [f.key, f.count])).toEqual([
      ['agreements', 3],
      ['receipts', 9120],
      ['supplier_invoices', 4012],
      ['other', 3],
      ['untyped', 1480],
    ])
    expect(data.folders.find((f) => f.key === 'supplier_invoices')?.types).toEqual([
      { doc_type: 'supplier_invoice', count: 4000 },
      { doc_type: 'credit_note', count: 12 },
    ])
    expect(vi.mocked(mockSupabase.rpc)).toHaveBeenCalledWith('arkiv_document_type_counts', { p_company_id: 'company-1', p_year: 2025 })
  })
})
