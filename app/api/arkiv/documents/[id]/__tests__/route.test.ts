import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

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
  it('is 404 for another company\'s document', async () => {
    enqueue({ data: null })
    expect((await parseJsonResponse(await call())).status).toBe(404)
  })

  it('returns the record with fields, facts, links and the verifikat', async () => {
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
    expect(view).toMatchObject({ file_name: 'Registreringsbevis.pdf', journal_entry: { id: 'je-1', voucher: 'A7' }, classification: { summary: 'Registreringsbevis för Arcim Technology AB.' } })
    expect((view.record as { fields: unknown[] }).fields).toEqual([{ field: 'org_number', label: 'org_number', value: '5595386219', page: 2, quote: 'Organisationsnummer 559538-6219', confidence: 1, under_review: false }])
    expect(view.facts).toEqual([{ fact_id: 'f1', predicate: 'org_number', label: 'Organisationsnummer', value_text: '5595386219', valid_from: null, sys_from: '2026-09-15', source_kind: 'extraction', superseded_by: false }])
    expect(view.links).toEqual([{ link_id: 'l1', target_kind: 'party', target_id: 'p1', basis: 'proven', method: 'org_number', label: 'Bolagsverket', href: '/parties/p1' }])
  })
})
