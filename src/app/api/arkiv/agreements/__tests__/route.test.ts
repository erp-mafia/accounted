import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/arkiv/agreements/dates', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/arkiv/agreements/dates')>()), todayIso: () => '2026-09-15' }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const call = () => GET(new Request('http://localhost/api/arkiv/agreements'), {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/agreements', () => {
  it('is 404 outside the rollout', async () => {
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'someone-else'
    expect((await parseJsonResponse(await call())).status).toBe(404)
  })

  it('returns an empty list without further reads', async () => {
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({ data: [] })
  })

  it('joins the counterparty, the next payment, the deadlines and the source page onto each agreement', async () => {
    enqueue({
      data: [
        { id: 'agr-1', kind: 'rental', title: 'Hyresavtal Vasagatan 12', status: 'active', counterparty_party_id: 'party-1', counterparty_name: 'Kvarnen', amount: '12500.00', currency: 'SEK', period: 'monthly', starts_on: '2026-01-01', ends_on: '2028-12-31', source_document_id: 'doc-1', sources: { monthly_rent: { page: 2 }, ends_on: { page: 3 } } },
        { id: 'agr-2', kind: 'loan', title: 'Lån 4711', status: 'active', counterparty_party_id: null, counterparty_name: 'Banken AB', amount: null, currency: 'SEK', period: null, starts_on: null, ends_on: null, source_document_id: 'doc-2', sources: {} },
      ],
    })
    enqueue({ data: [{ id: 'party-1', display_name: 'Fastighets AB Kvarnen' }] })
    enqueue({
      data: [
        { agreement_id: 'agr-1', due_on: '2026-08-01', amount: '12500.00', currency: 'SEK', status: 'missed', kind: 'payment' },
        { agreement_id: 'agr-1', due_on: '2026-09-01', amount: '12500.00', currency: 'SEK', status: 'matched', kind: 'payment' },
        { agreement_id: 'agr-1', due_on: '2026-10-01', amount: '12500.00', currency: 'SEK', status: 'expected', kind: 'payment' },
      ],
    })
    enqueue({ data: [{ source_key: 'agreement:agr-1:notice', due_date: '2028-03-31', title: 'Sista dag att säga upp hyresavtalet Vasagatan 12' }, { source_key: 'agreement:agr-1:end', due_date: '2028-12-31', title: 'löper ut' }] })
    enqueue({ data: [{ id: 'doc-1', file_name: 'hyresavtal.pdf' }, { id: 'doc-2', file_name: 'lan.pdf' }] })
    enqueue({ data: [{ detail: { agreement_ids: ['agr-1', 'agr-9'] } }] }) // open duplicate findings

    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    const [rental, loan] = (body as { data: Array<Record<string, unknown>> }).data
    expect(rental).toEqual({
      id: 'agr-1',
      kind: 'rental',
      title: 'Hyresavtal Vasagatan 12',
      status: 'active',
      counterparty: { party_id: 'party-1', name: 'Fastighets AB Kvarnen' },
      amount: 12500,
      currency: 'SEK',
      period: 'monthly',
      starts_on: '2026-01-01',
      ends_on: '2028-12-31',
      next_payment: { due_on: '2026-10-01', amount: 12500, currency: 'SEK', status: 'expected', kind: 'payment' },
      notice_deadline: { due_date: '2028-03-31', title: 'Sista dag att säga upp hyresavtalet Vasagatan 12' },
      end_deadline: { due_date: '2028-12-31', title: 'löper ut' },
      source: { document_id: 'doc-1', file_name: 'hyresavtal.pdf', page: 2 },
      duplicate: true,
    })
    expect(loan).toMatchObject({ counterparty: { party_id: null, name: 'Banken AB' }, amount: null, next_payment: null, notice_deadline: null, end_deadline: null, source: { document_id: 'doc-2', file_name: 'lan.pdf', page: null }, duplicate: false })
  })

  it('shows the latest missed payment when nothing is expected ahead', async () => {
    enqueue({ data: [{ id: 'agr-1', kind: 'subscription', title: 'Abonnemang X', status: 'active', counterparty_party_id: null, counterparty_name: null, amount: '299', currency: 'SEK', period: 'monthly', starts_on: null, ends_on: null, source_document_id: 'doc-1', sources: {} }] })
    enqueue({ data: [] })
    enqueue({ data: [{ agreement_id: 'agr-1', due_on: '2026-08-10', amount: '299', currency: 'SEK', status: 'missed', kind: 'payment' }] })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'doc-1', file_name: 'x.pdf' }] })
    enqueue({ data: [] })
    const { body } = await parseJsonResponse(await call())
    expect((body as { data: Array<{ next_payment: { status: string; due_on: string } }> }).data[0].next_payment).toMatchObject({ status: 'missed', due_on: '2026-08-10' })
  })
})
