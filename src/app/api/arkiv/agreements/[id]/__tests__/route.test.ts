import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/arkiv/agreements/dates', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/arkiv/agreements/dates')>()), todayIso: () => '2026-09-15' }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const AGR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const call = () => GET(new Request(`http://localhost/api/arkiv/agreements/${AGR}`), { params: Promise.resolve({ id: AGR }) } as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/agreements/[id]', () => {
  it('is 404 when the agreement is not the company\'s', async () => {
    enqueue({ data: null })
    expect((await parseJsonResponse(await call())).status).toBe(404)
  })

  it('assembles facts, history, payments, dates, documents and the source excerpt', async () => {
    enqueue({ data: { id: AGR, kind: 'rental', title: 'Hyresavtal Vasagatan 12', status: 'active', counterparty_party_id: 'p1', counterparty_name: 'Kvarnen', starts_on: '2026-01-01', ends_on: '2028-12-31', amount: '12500.00', currency: 'SEK', period: 'monthly', source_document_id: 'doc-1', sources: { monthly_rent: { page: 2, quote: 'Hyran uppgår till 12 500 kr' } } } })
    enqueue({ data: { id: 'p1', display_name: 'Fastighets AB Kvarnen' } })
    enqueue({ data: { id: 'doc-1', file_name: 'hyresavtal.pdf' } })
    enqueue({
      data: [
        { id: 'f2', predicate: 'amount', value_text: '12500', valid_from: null, valid_to: null, sys_from: '2026-09-15', sys_to: null, rank: 'normal', status: 'confirmed', source_kind: 'extraction', source_document_id: 'doc-1', sources: [{ document_id: 'doc-1', page: 2, quote: 'Hyran' }], supersedes_id: 'f1' },
        { id: 'f1', predicate: 'amount', value_text: '12000', valid_from: null, valid_to: null, sys_from: '2026-08-01', sys_to: '2026-09-15', rank: 'normal', status: 'confirmed', source_kind: 'extraction', source_document_id: 'doc-1', sources: [], supersedes_id: null },
      ],
    })
    enqueue({ data: [{ id: 'o1', kind: 'payment', due_on: '2026-10-01', amount: '12500', currency: 'SEK', amount_is_estimate: false, status: 'expected', transaction_id: null }] })
    enqueue({ data: [{ id: 'd1', title: 'Sista dag att säga upp', due_date: '2028-03-31', status: 'upcoming' }] })
    enqueue({ data: [{ document_id: 'doc-2', basis: 'proven', method: 'person' }] })
    enqueue({ data: [{ id: 'doc-1', file_name: 'hyresavtal.pdf', journal_entry_id: null }, { id: 'doc-2', file_name: 'tillagg.pdf', journal_entry_id: 'je-1' }] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    const view = (body as { data: Record<string, unknown> }).data
    expect(view).toMatchObject({ title: 'Hyresavtal Vasagatan 12', counterparty: { party_id: 'p1', name: 'Fastighets AB Kvarnen' }, amount: 12500, source: { document_id: 'doc-1', file_name: 'hyresavtal.pdf', page: 2, field: 'monthly_rent', quote: 'Hyran uppgår till 12 500 kr' }, verifikat_count: 1 })
    expect((view.facts as Array<{ fact_id: string; label: string; source: { page: number } }>)).toEqual([expect.objectContaining({ fact_id: 'f2', label: 'Belopp per period', source: { document_id: 'doc-1', page: 2, quote: 'Hyran' } })])
    expect((view.history as Array<{ fact_id: string }>).map((f) => f.fact_id)).toEqual(['f1'])
    expect(view.obligations).toEqual([{ id: 'o1', kind: 'payment', due_on: '2026-10-01', amount: 12500, currency: 'SEK', estimate: false, status: 'expected', transaction_id: null }])
    expect(view.documents).toEqual([
      { document_id: 'doc-1', file_name: 'hyresavtal.pdf', basis: 'proven', method: 'derived' },
      { document_id: 'doc-2', file_name: 'tillagg.pdf', basis: 'proven', method: 'person' },
    ])
  })
})
