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
        { id: 'doc-booked', created_at: '2026-09-13T10:00:00Z', file_name: 'kvitto.pdf', doc_type: 'other', admission_state: 'admitted', journal_entry_id: 'je-9' },
      ],
    })
    enqueue({ data: [{ id: 'je-9', voucher_series: 'A', voucher_number: 9 }] })
    const { body } = await parseJsonResponse(await call())
    const rows = (body as { data: Array<{ document_id: string; linked: Record<string, unknown> }> }).data
    expect(rows.find((r) => r.document_id === 'doc-new')?.linked).toMatchObject({ unclassified: false, reading: true })
    expect(rows.find((r) => r.document_id === 'doc-other')?.linked).toMatchObject({ unclassified: true, reading: false })
    // Booked: the verifikat already says what it is, so nobody is asked.
    expect(rows.find((r) => r.document_id === 'doc-booked')?.linked).toMatchObject({ unclassified: false, voucher: 'A9' })
  })

  it('searches page text and file names and answers empty when nothing matches', async () => {
    enqueue({ data: [] }) // search_document_pages
    enqueue({ data: [] }) // file names
    const { status, body } = await parseJsonResponse(await call('?q=hyra'))
    expect(status).toBe(200)
    expect(body).toEqual({ data: [] })
  })
})
