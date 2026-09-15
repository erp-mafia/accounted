import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const call = (qs = '') => GET(new Request(`http://localhost/api/arkiv/documents${qs}`), {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/documents', () => {
  it('rejects an unknown type and an out-of-range year', async () => {
    expect((await parseJsonResponse(await call('?type=spaceship'))).status).toBe(400)
    expect((await parseJsonResponse(await call('?year=1999'))).status).toBe(400)
  })

  it('lists documents with their counterparty, amount and links, an agreement row pointing at its page', async () => {
    enqueue({
      data: [
        { id: 'doc-a', created_at: '2026-09-15T10:00:00Z', file_name: 'lan.pdf', doc_type: 'agreement.loan', admission_state: 'admitted', journal_entry_id: null },
        { id: 'doc-b', created_at: '2026-09-14T10:00:00Z', file_name: 'kvitto.jpg', doc_type: 'receipt', admission_state: 'admitted', journal_entry_id: 'je-1' },
        { id: 'doc-c', created_at: '2026-09-13T10:00:00Z', file_name: 'foto.heic', doc_type: null, admission_state: 'held', journal_entry_id: null },
      ],
    })
    enqueue({ data: [{ document_id: 'doc-b', payload: { counterparty_name: { normalized: 'APO AB' }, total_amount: { normalized: 673 }, currency: { normalized: 'SEK' } } }] })
    enqueue({ data: [{ id: 'agr-1', source_document_id: 'doc-a', counterparty_name: 'Almi Stockholm AB', amount: '10417.00', currency: 'SEK' }] })
    enqueue({ data: [{ source_document_id: 'doc-a' }, { source_document_id: 'doc-a' }] })
    const { status, body } = await parseJsonResponse(await call('?type=agreement'))
    expect(status).toBe(200)
    const rows = (body as { data: Array<Record<string, unknown>> }).data
    expect(rows[0]).toMatchObject({ document_id: 'doc-a', counterparty: 'Almi Stockholm AB', amount: 10417, currency: 'SEK', linked: { agreement_id: 'agr-1', facts: 2, held: false, journal_entry_id: null }, href: '/arkiv/avtal/agr-1' })
    expect(rows[1]).toMatchObject({ counterparty: 'APO AB', amount: 673, linked: { journal_entry_id: 'je-1' }, href: '/arkiv/dokument/doc-b' })
    expect(rows[2]).toMatchObject({ linked: { held: true }, amount: null })
    expect(findCalls('document_attachments', 'in')).toContainEqual(['doc_type', ['agreement.lease', 'agreement.loan', 'agreement.rental', 'agreement.insurance', 'agreement.employment', 'agreement.shareholder', 'agreement.investment', 'agreement.customer', 'agreement.subscription', 'agreement.other'].filter(() => true).sort()].map((v) => (Array.isArray(v) ? expect.arrayContaining(['agreement.loan']) : v)))
  })

  it('searches page text and file names and answers empty when nothing matches', async () => {
    enqueue({ data: [] }) // search_document_pages
    enqueue({ data: [] }) // file names
    const { status, body } = await parseJsonResponse(await call('?q=hyra'))
    expect(status).toBe(200)
    expect(body).toEqual({ data: [] })
  })
})
