import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const call = () => GET(new Request(`http://localhost/api/arkiv/documents/${DOC}`), { params: Promise.resolve({ id: DOC }) } as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/documents/[id]', () => {
  it('is 404 for another company\'s document, in the canonical envelope', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(404)
    expect((body as { error: Record<string, unknown> }).error).toMatchObject({ code: 'NOT_FOUND', requestId: expect.stringMatching(/^req_/) })
  })

  it('answers a failed document read in the canonical envelope', async () => {
    enqueue({ error: { message: 'boom', code: 'XX000' } })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(500)
    expect((body as { error: Record<string, unknown> }).error).toMatchObject({ code: expect.any(String), message: expect.any(String), requestId: expect.stringMatching(/^req_/) })
  })

  it('returns the record with fields, facts, links and the verifikat', async () => {
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
    enqueue({ data: { id: DOC, file_name: 'Registreringsbevis.pdf', created_at: '2026-09-15', page_count: 3, doc_type: 'registration.bolagsverket', admission_state: 'admitted', journal_entry_id: 'je-1' } })
    enqueue({ data: { summary: 'Registreringsbevis för Arcim Technology AB.', confidence: 0.98, decided_by: 'model' } })
    enqueue({ data: { id: 'ext-1', schema_type: 'registration.bolagsverket', pass: 'consensus', payload: { org_number: { value: '559538-6219', normalized: '5595386219', page: 2, quote: 'Organisationsnummer 559538-6219', confidence: 1 } }, review_fields: [] } })
    enqueue({ data: [{ id: 'f1', predicate: 'org_number', value_text: '5595386219', valid_from: null, sys_from: '2026-09-15', sys_to: null, source_kind: 'extraction', rank: 'normal' }] })
    enqueue({ data: [{ id: 'l1', target_kind: 'party', target_id: 'p1', party_id: 'p1', agreement_id: null, asset_id: null, basis: 'proven', method: 'org_number' }] })
    enqueue({ data: null })
    enqueue({ data: { id: 'je-1', voucher_series: 'A', voucher_number: 7 } })
    enqueue({ data: [{ id: 'p1', display_name: 'Bolagsverket' }] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    const view = (body as { data: Record<string, unknown> }).data
    expect(view).toMatchObject({ file_name: 'Registreringsbevis.pdf', journal_entry: { id: 'je-1', voucher: 'A7' }, deletable: false, classification: { summary: 'Registreringsbevis för Arcim Technology AB.' } })
    expect((view.record as { fields: unknown[] }).fields).toEqual([{ field: 'org_number', label: 'org_number', value: '5595386219', page: 2, quote: 'Organisationsnummer 559538-6219', confidence: 1, under_review: false }])
    expect(view.facts).toEqual([{ fact_id: 'f1', predicate: 'org_number', label: 'Organisationsnummer', value_text: '5595386219', valid_from: null, sys_from: '2026-09-15', source_kind: 'extraction', superseded_by: false }])
    expect(view.links).toEqual([{ link_id: 'l1', target_kind: 'party', target_id: 'p1', basis: 'proven', method: 'org_number', label: 'Bolagsverket', href: '/parties?party=p1' }])
  })

  it('outside the brain the record is the document, what it is and its verifikat: no reading, facts, links or agreement are fetched', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: { id: DOC, file_name: 'Registreringsbevis.pdf', created_at: '2026-09-15', page_count: 3, doc_type: 'registration.bolagsverket', admission_state: 'admitted', journal_entry_id: 'je-1', pages_read_at: '2026-09-15', read_error: null, extracted_data: null } })
    enqueue({ data: { summary: 'Registreringsbevis för Arcim Technology AB.', confidence: 0.98, decided_by: 'model', signals: [] } })
    enqueue({ data: { id: 'je-1', voucher_series: 'A', voucher_number: 7 } })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    const view = (body as { data: Record<string, unknown> }).data
    expect(view).toMatchObject({ title: 'Registreringsbevis', journal_entry: { id: 'je-1', voucher: 'A7' }, deletable: false, classification: { summary: 'Registreringsbevis för Arcim Technology AB.' }, read: { state: 'read' }, record: null, facts: [], links: [], agreement: null })
  })

  // crm#230: the record offers a delete only where DELETE /api/documents/[id] would take it (canDeleteDocument).
  it('says an unlinked document is deletable', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: { id: DOC, file_name: 'kvitto.pdf', created_at: '2026-09-15', page_count: 1, doc_type: 'receipt', admission_state: 'admitted', journal_entry_id: null, journal_entry_line_id: null, pages_read_at: '2026-09-15', read_error: null, extracted_data: null } })
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect((body as { data: Record<string, unknown> }).data).toMatchObject({ journal_entry: null, deletable: true })
  })

  it('says a document linked only at a verifikat line is not deletable', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: { id: DOC, file_name: 'kvitto.pdf', created_at: '2026-09-15', page_count: 1, doc_type: 'receipt', admission_state: 'admitted', journal_entry_id: null, journal_entry_line_id: 'line-1', pages_read_at: '2026-09-15', read_error: null, extracted_data: null } })
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect((body as { data: Record<string, unknown> }).data).toMatchObject({ deletable: false })
  })

  // crm#230: a document a registered record holds is not offered, by the server's own rule (documentDeleteRefusal).
  // Pins are read in readDocumentDeletePins' order: supplier invoices, expense claims, bank transactions,
  // inbox items by file, inbox items by received Peppol XML.
  const unlinkedReceipt = { id: DOC, file_name: 'kvitto.pdf', created_at: '2026-09-15', page_count: 1, doc_type: 'receipt', admission_state: 'admitted', journal_entry_id: null, journal_entry_line_id: null, pages_read_at: '2026-09-15', read_error: null, extracted_data: null }

  it('does not offer the delete for the underlag of a supplier invoice', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: unlinkedReceipt })
    enqueue({ data: null })
    enqueue({ data: [{ id: 'si-1' }] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect((body as { data: Record<string, unknown> }).data).toMatchObject({ deletable: false })
    expect(findCalls('supplier_invoices', 'eq')).toEqual([['company_id', 'company-1'], ['document_id', DOC]])
  })

  it('does not offer the delete for the underlag of an utlagg', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: unlinkedReceipt })
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'ec-1' }] })
    const { body } = await parseJsonResponse(await call())
    expect((body as { data: Record<string, unknown> }).data).toMatchObject({ deletable: false })
  })

  it('does not offer the delete for the received Peppol XML of a booked e-invoice', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: { ...unlinkedReceipt, file_name: 'peppol-faktura-1.xml', doc_type: 'invoice.supplier' } })
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [{ created_journal_entry_id: 'je-1', created_supplier_invoice_id: null }] })
    const { body } = await parseJsonResponse(await call())
    expect((body as { data: Record<string, unknown> }).data).toMatchObject({ deletable: false })
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['channel_context->>peppol_xml_document_id', DOC])
  })

  it('offers the delete for a document whose inbox item was never booked', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: unlinkedReceipt })
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [{ created_journal_entry_id: null, created_supplier_invoice_id: null }] })
    enqueue({ data: [] })
    const { body } = await parseJsonResponse(await call())
    expect((body as { data: Record<string, unknown> }).data).toMatchObject({ deletable: true })
  })

  it('does not offer the delete for the file of an inbox item turned into a supplier invoice', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: unlinkedReceipt })
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [{ created_journal_entry_id: null, created_supplier_invoice_id: 'si-1' }] })
    enqueue({ data: [] })
    const { body } = await parseJsonResponse(await call())
    expect((body as { data: Record<string, unknown> }).data).toMatchObject({ deletable: false })
  })

  it('does not offer the delete for the underlag of a bank transaction', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: unlinkedReceipt })
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'tx-1' }] })
    const { body } = await parseJsonResponse(await call())
    expect((body as { data: Record<string, unknown> }).data).toMatchObject({ deletable: false })
    expect(findCalls('transactions', 'eq')).toEqual([['company_id', 'company-1'], ['document_id', DOC]])
  })

  // CodeRabbit on #3332: the pin read's failure is the canonical envelope withRouteContext builds, not a hand-built { error: string }.
  it('is 500 in the canonical envelope when a pin lookup fails', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: unlinkedReceipt })
    enqueue({ data: null })
    enqueue({ error: { message: 'boom' } })
    const res = await call()
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(500)
    const envelope = (body as { error: Record<string, unknown> }).error
    expect(envelope).toMatchObject({ code: 'INTERNAL_ERROR', message: expect.any(String), message_en: expect.any(String), requestId: expect.stringMatching(/^req_/) })
    expect(res.headers.get('X-Request-Id')).toBe(envelope.requestId)
  })

  it('reads no pins for a document linked to a verifikat', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    enqueue({ data: { ...unlinkedReceipt, journal_entry_id: 'je-1' } })
    enqueue({ data: null })
    enqueue({ data: { id: 'je-1', voucher_series: 'A', voucher_number: 7 } })
    await call()
    expect(findCalls('supplier_invoices', 'select')).toEqual([])
  })
})
