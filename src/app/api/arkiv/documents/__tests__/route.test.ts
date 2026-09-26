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
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
    enqueue({
      data: [
        { id: 'doc-a', created_at: '2026-09-15T10:00:00Z', file_name: 'lan.pdf', doc_type: 'agreement.loan', admission_state: 'admitted', journal_entry_id: null },
        { id: 'doc-b', created_at: '2026-09-14T10:00:00Z', file_name: 'kvitto.jpg', doc_type: 'receipt', admission_state: 'admitted', journal_entry_id: 'je-1' },
        { id: 'doc-c', created_at: '2026-09-13T10:00:00Z', file_name: 'foto.heic', doc_type: null, admission_state: 'held', journal_entry_id: null },
      ],
    })
    enqueue({ data: [{ document_id: 'doc-b', payload: { counterparty_name: { normalized: 'APO AB' }, total_amount: { normalized: 673 }, currency: { normalized: 'SEK' } } }] })
    enqueue({ data: [{ id: 'agr-1', source_document_id: 'doc-a', counterparty_name: 'Almi Stockholm AB', amount: '10417.00', currency: 'SEK' }] })
    enqueue({ data: [{ id: 'je-1', voucher_series: 'A', voucher_number: 5 }] })
    const { status, body } = await parseJsonResponse(await call('?type=agreement'))
    expect(status).toBe(200)
    // Bank responses and XML payloads are archives, never documents to type: kept out at the query.
    expect(findCalls('document_attachments', 'or').map((c) => c[0])).toContain('mime_type.is.null,mime_type.not.in.(application/xml,text/xml,application/json)')
    const rows = (body as { data: Array<Record<string, unknown>> }).data
    expect(rows[0]).toMatchObject({ document_id: 'doc-a', counterparty: 'Almi Stockholm AB', amount: 10417, currency: 'SEK', linked: { agreement_id: 'agr-1', held: false, journal_entry_id: null }, href: '/arkiv/avtal/agr-1' })
    expect(rows[1]).toMatchObject({ counterparty: 'APO AB', amount: 673, linked: { journal_entry_id: 'je-1', voucher: 'A5' }, href: '/arkiv/dokument/doc-b' })
    expect(rows[0]).not.toHaveProperty('linked.facts')
    expect(rows[2]).toMatchObject({ linked: { held: true }, amount: null })
    expect(findCalls('document_attachments', 'in')).toContainEqual(['doc_type', ['agreement.lease', 'agreement.loan', 'agreement.rental', 'agreement.insurance', 'agreement.employment', 'agreement.shareholder', 'agreement.investment', 'agreement.customer', 'agreement.subscription', 'agreement.other'].filter(() => true).sort()].map((v) => (Array.isArray(v) ? expect.arrayContaining(['agreement.loan']) : v)))
  })

  it('outside the brain reads only the documents and their vouchers: the row is the file, its type and its verifikat', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({
      data: [
        { id: 'doc-a', created_at: '2026-09-15T10:00:00Z', file_name: 'Almilånedokument.pdf', doc_type: 'agreement.loan', admission_state: 'admitted', journal_entry_id: null },
        { id: 'doc-b', created_at: '2026-09-14T10:00:00Z', file_name: 'kvitto.jpg', doc_type: 'receipt', admission_state: 'admitted', journal_entry_id: 'je-1', extracted_data: { supplier: { name: 'Systembolaget' }, invoice: { invoiceDate: '2026-09-11', currency: 'SEK' }, totals: { total: 2388.8 } } },
        // Minutes the inbox once read as an invoice: the counterparty carries over, the "total" (a prominent figure) does not.
        { id: 'doc-c', created_at: '2026-09-13T10:00:00Z', file_name: 'Stamma.pdf', doc_type: 'minutes.agm', admission_state: 'admitted', journal_entry_id: null, extracted_data: { supplier: { name: 'Arcim Technology AB' }, invoice: { invoiceDate: '2026-06-01', currency: 'SEK' }, totals: { total: 20.83 } } },
      ],
    })
    enqueue({ data: [{ id: 'je-1', voucher_series: 'A', voucher_number: 5 }] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    const rows = (body as { data: Array<Record<string, unknown>> }).data
    const row = (id: string) => rows.find((r) => r.document_id === id)
    // An agreement with no reading is titled by its type: the file name stays in the row's title attribute.
    expect(row('doc-a')).toMatchObject({ title: 'Låneavtal', file_name: 'Almilånedokument.pdf', counterparty: null, amount: null, href: '/arkiv/dokument/doc-a', linked: { agreement_id: null } })
    // A receipt the inbox read: titled, dated and priced from that reading (and sorted by that date).
    expect(row('doc-b')).toMatchObject({ title: 'Kvitto Systembolaget', counterparty: 'Systembolaget', amount: 2388.8, currency: 'SEK', document_date: '2026-09-11', linked: { voucher: 'A5' }, href: '/arkiv/dokument/doc-b' })
    expect(row('doc-c')).toMatchObject({ title: 'Bolagsstämma', counterparty: 'Arcim Technology AB', amount: null, currency: null })
    expect(rows.map((r) => r.document_id)).toEqual(['doc-a', 'doc-c', 'doc-b'])
    expect(findCalls('document_extractions', 'in')).toEqual([])
    expect(findCalls('agreements', 'in')).toEqual([])
  })

  it('asks a person only about what the model read and could not name; a document with no type yet is being read', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({
      data: [
        { id: 'doc-new', created_at: '2026-09-15T10:00:00Z', file_name: 'scan.pdf', doc_type: null, admission_state: 'admitted', journal_entry_id: null },
        { id: 'doc-other', created_at: '2026-09-14T10:00:00Z', file_name: 'okänd.pdf', doc_type: 'other', admission_state: 'admitted', journal_entry_id: null },
      ],
    })
    const { body } = await parseJsonResponse(await call())
    const rows = (body as { data: Array<{ document_id: string; linked: Record<string, unknown> }> }).data
    expect(rows.find((r) => r.document_id === 'doc-new')?.linked).toMatchObject({ unclassified: false, reading: true })
    expect(rows.find((r) => r.document_id === 'doc-other')?.linked).toMatchObject({ unclassified: true, reading: false })
  })

  it('rejects an unknown folder', async () => {
    expect((await parseJsonResponse(await call('?folder=attic'))).status).toBe(400)
  })

  it('pages one folder over the whole archive in the database order, with where the next page starts', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    // arkiv_document_page: one more row than asked says there is a next page.
    enqueue({ data: [{ id: 'doc-b' }, { id: 'doc-a' }, { id: 'doc-c' }] })
    enqueue({
      data: [
        { id: 'doc-a', created_at: '2026-09-15T10:00:00Z', file_name: 'a.pdf', doc_type: 'receipt', admission_state: 'admitted', journal_entry_id: null },
        { id: 'doc-b', created_at: '2026-09-14T10:00:00Z', file_name: 'b.pdf', doc_type: 'receipt', admission_state: 'admitted', journal_entry_id: null },
      ],
    })
    const { status, body } = await parseJsonResponse(await call('?folder=receipts&limit=2&offset=40&year=2025'))
    expect(status).toBe(200)
    const out = body as { data: Array<{ document_id: string }>; next_offset: number | null }
    expect(out.data.map((r) => r.document_id)).toEqual(['doc-b', 'doc-a'])
    expect(out.next_offset).toBe(42)
    expect(vi.mocked(mockSupabase.rpc)).toHaveBeenCalledWith('arkiv_document_page', {
      p_company_id: 'company-1',
      p_mode: 'in',
      p_types: ['receipt'],
      p_year: 2025,
      p_offset: 40,
      p_limit: 3,
    })
    expect(findCalls('document_attachments', 'in')).toContainEqual(['id', ['doc-b', 'doc-a']])
  })

  it('pages the other folder as every type no folder names, and the last page has no next', async () => {
    enqueue({ data: [{ id: 'doc-x' }] })
    enqueue({ data: [{ id: 'doc-x', created_at: '2026-09-15T10:00:00Z', file_name: 'x.pdf', doc_type: 'something_new', admission_state: 'admitted', journal_entry_id: null }] })
    const { body } = await parseJsonResponse(await call('?folder=other'))
    expect((body as { next_offset: number | null }).next_offset).toBeNull()
    const args = vi.mocked(mockSupabase.rpc).mock.calls.find((c) => c[0] === 'arkiv_document_page')?.[1] as { p_mode: string; p_types: string[] }
    expect(args.p_mode).toBe('not_in')
    expect(args.p_types).toEqual(expect.arrayContaining(['receipt', 'agreement.loan', 'supplier_invoice']))
    expect(args.p_types).not.toContain('other')
  })

  it('answers an empty folder page without reading documents', async () => {
    enqueue({ data: [] })
    const { body } = await parseJsonResponse(await call('?folder=untyped'))
    expect(body).toEqual({ data: [], next_offset: null })
    expect(findCalls('document_attachments', 'in')).toEqual([])
  })

  it('searches page text and file names and answers empty when nothing matches', async () => {
    enqueue({ data: [] }) // search_document_pages
    enqueue({ data: [] }) // file names
    const { status, body } = await parseJsonResponse(await call('?q=hyra'))
    expect(status).toBe(200)
    expect(body).toEqual({ data: [] })
  })
})
