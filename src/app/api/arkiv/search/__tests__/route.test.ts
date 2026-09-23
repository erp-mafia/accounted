import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/arkiv/events', () => ({ captureArkivEvent: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { captureArkivEvent } from '@/lib/arkiv/events'

const DOC = '11111111-1111-4111-8111-111111111111'
const AGR = '22222222-2222-4222-8222-222222222222'
const call = (qs: string) => GET(new Request(`http://localhost/api/arkiv/search${qs}`), {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/search', () => {
  it('is 404 outside the rollout', async () => {
    process.env.ARKIV_COMPANY_IDS = 'someone-else'
    expect((await parseJsonResponse(await call('?q=hyra'))).status).toBe(404)
  })

  it('is 400 for a query too short, or a kind it does not know', async () => {
    expect((await parseJsonResponse(await call('?q=h'))).status).toBe(400)
    expect((await parseJsonResponse(await call(''))).status).toBe(400)
    expect((await parseJsonResponse(await call('?q=hyra&kinds=party'))).status).toBe(400)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('titles a page hit like the table does, agreement title first, and points every hit at its record and its page', async () => {
    enqueue({ data: [{ document_id: DOC, page_no: 2, file_name: 'IMG_7485.jpg', headline: '# Hyra\n\n**Hyran** uppgår till <b>12 500</b>', rank: 1 }] })
    enqueue({ data: [{ id: AGR, title: 'Hyresavtal Vasagatan 12', counterparty_name: 'Kvarnen AB', kind: 'rental', ends_on: null }] })
    enqueue({ data: [{ id: 'f1', predicate: 'vat_period', value_text: 'kvartal', subject_kind: 'company', subject_id: 'company-1', source_document_id: null }] })
    enqueue({ data: [{ id: DOC, file_name: 'IMG_7485.jpg', doc_type: 'agreement.rental' }] })
    enqueue({ data: [{ document_id: DOC, payload: { landlord_name: { value: 'Kvarnen AB', normalized: 'Kvarnen AB' } } }] })
    enqueue({ data: [{ source_document_id: DOC, title: 'Hyresavtal Vasagatan 12' }] })
    const { status, body } = await parseJsonResponse(await call('?q=hyra'))
    expect(status).toBe(200)
    expect(body).toEqual({
      data: {
        query: 'hyra',
        count: 3,
        hits: [
          {
            record_ref: `document:${DOC}`,
            kind: 'document',
            title: 'Hyresavtal Vasagatan 12',
            subtitle: 'IMG_7485.jpg',
            snippet: 'Hyra Hyran uppgår till <b>12 500</b>',
            page: 2,
            href: `/arkiv/dokument/${DOC}?page=2`,
            source_href: `/api/documents/${DOC}/inline#page=2`,
          },
          { record_ref: `agreement:${AGR}`, kind: 'agreement', title: 'Hyresavtal Vasagatan 12', subtitle: null, snippet: 'rental · Kvarnen AB', page: null, href: `/arkiv/avtal/${AGR}`, source_href: null },
          // A fact read off the ledger or the registers has no page of its own: the hit is the answer.
          { record_ref: 'fact:f1', kind: 'fact', title: 'Momsperiod: kvartal', subtitle: null, snippet: null, page: null, href: null, source_href: null },
        ],
      },
    })
    expect(findCalls('document_attachments', 'in')).toEqual([['id', [DOC]]])
    expect(findCalls('agreements', 'in')).toEqual([['source_document_id', [DOC]]])
    expect(captureArkivEvent).toHaveBeenCalledWith('arkiv_searched', { companyId: 'company-1', userId: 'user-1', kinds: 'all', query_length: 4, hits: 3 })
  })

  it('passes the kinds and the limit through, and opens a fact where it was read from', async () => {
    enqueue({ data: [{ id: 'f2', predicate: 'org_number', value_text: '559000-0001', subject_kind: 'company', subject_id: 'company-1', source_document_id: DOC }] })
    const { status, body } = await parseJsonResponse(await call('?q=5590&kinds=fact&limit=3'))
    expect(status).toBe(200)
    expect(body).toEqual({
      data: {
        query: '5590',
        count: 1,
        hits: [{ record_ref: 'fact:f2', kind: 'fact', title: 'Organisationsnummer: 559000-0001', subtitle: null, snippet: null, page: null, href: `/arkiv/dokument/${DOC}`, source_href: `/api/documents/${DOC}/inline` }],
      },
    })
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(findCalls('company_facts', 'limit')).toEqual([[3]])
    expect(findCalls('document_attachments', 'in')).toEqual([])
  })
})
