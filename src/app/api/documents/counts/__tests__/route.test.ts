import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import { NextResponse } from 'next/server'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const mockUser = { id: 'user-1', email: 't@t.se' }

const JE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const JE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const JE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function makeReq(ids: string[]) {
  return new Request(
    `http://localhost/api/documents/counts?journal_entry_ids=${ids.join(',')}`,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: mockUser,
    supabase: mockSupabase,
  })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

// Queue order mirrors the route: the Promise.all (direct docs, supplier_invoices
// references, supplier_invoice_payments references), then the customer-invoice
// resolver (invoices by journal_entry_id, invoice_payments by journal_entry_id).
// The `document` embed carries the anchor state (journal_entry_id) of the SI's
// retained doc.
function enqueueAll(opts: {
  direct?: Array<{ id: string; journal_entry_id: string }>
  si?: Array<{
    document_id: string
    registration_journal_entry_id: string | null
    payment_journal_entry_id: string | null
    document: { journal_entry_id: string | null } | null
  }>
  sip?: Array<{
    journal_entry_id: string
    supplier_invoice: {
      document_id: string | null
      document: { journal_entry_id: string | null } | null
    } | null
  }>
  invoices?: Array<{ id: string; journal_entry_id: string | null }>
  payments?: Array<{ id: string; invoice_id: string | null; journal_entry_id: string | null }>
}) {
  enqueue({ data: opts.direct ?? [], error: null })
  enqueue({ data: opts.si ?? [], error: null })
  enqueue({ data: opts.sip ?? [], error: null })
  enqueue({ data: opts.invoices ?? [], error: null })
  enqueue({ data: opts.payments ?? [], error: null })
}

describe('GET /api/documents/counts', () => {
  it('returns 401 when not authenticated', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(makeReq([JE_A]))
    expect((await parseJsonResponse(res)).status).toBe(401)
  })

  it('returns 400 without journal_entry_ids', async () => {
    const res = await GET(new Request('http://localhost/api/documents/counts'))
    expect((await parseJsonResponse(res)).status).toBe(400)
  })

  it('returns 400 for more than 50 ids', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`)
    const res = await GET(makeReq(ids))
    expect((await parseJsonResponse(res)).status).toBe(400)
  })

  it('returns 400 for non-UUID ids (they are interpolated into a PostgREST or-filter)', async () => {
    const res = await GET(makeReq([JE_A, 'registration_journal_entry_id.in.(x)']))
    expect((await parseJsonResponse(res)).status).toBe(400)
  })

  it('counts direct attachments per entry', async () => {
    enqueueAll({
      direct: [
        { id: 'doc-1', journal_entry_id: JE_A },
        { id: 'doc-2', journal_entry_id: JE_A },
        { id: 'doc-3', journal_entry_id: JE_B },
      ],
    })
    const res = await GET(makeReq([JE_A, JE_B, JE_C]))
    const { status, body } = await parseJsonResponse<{ data: Record<string, number> }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ [JE_A]: 2, [JE_B]: 1 })
  })

  it('counts a supplier invoice doc for both referenced entries (registration + payment)', async () => {
    enqueueAll({
      si: [
        {
          document_id: 'doc-si',
          registration_journal_entry_id: JE_A,
          payment_journal_entry_id: JE_B,
          document: { journal_entry_id: JE_A },
        },
      ],
    })
    const res = await GET(makeReq([JE_A, JE_B]))
    const { body } = await parseJsonResponse<{ data: Record<string, number> }>(res)
    expect(body.data).toEqual({ [JE_A]: 1, [JE_B]: 1 })
  })

  it('ignores an UNANCHORED supplier invoice doc (outside the WORM deletion guards)', async () => {
    enqueueAll({
      si: [
        {
          document_id: 'doc-si',
          registration_journal_entry_id: JE_A,
          payment_journal_entry_id: JE_B,
          document: { journal_entry_id: null },
        },
      ],
      sip: [
        {
          journal_entry_id: JE_C,
          supplier_invoice: { document_id: 'doc-si', document: { journal_entry_id: null } },
        },
      ],
    })
    const res = await GET(makeReq([JE_A, JE_B, JE_C]))
    const { body } = await parseJsonResponse<{ data: Record<string, number> }>(res)
    expect(body.data).toEqual({})
  })

  it('counts a partial-payment reference via supplier_invoice_payments', async () => {
    enqueueAll({
      sip: [
        {
          journal_entry_id: JE_A,
          supplier_invoice: { document_id: 'doc-si', document: { journal_entry_id: JE_B } },
        },
      ],
    })
    const res = await GET(makeReq([JE_A]))
    const { body } = await parseJsonResponse<{ data: Record<string, number> }>(res)
    expect(body.data).toEqual({ [JE_A]: 1 })
  })

  it('deduplicates a doc that is both directly linked and referenced', async () => {
    enqueueAll({
      direct: [{ id: 'doc-si', journal_entry_id: JE_A }],
      si: [
        {
          document_id: 'doc-si',
          registration_journal_entry_id: JE_A,
          payment_journal_entry_id: null,
          document: { journal_entry_id: JE_A },
        },
      ],
    })
    const res = await GET(makeReq([JE_A]))
    const { body } = await parseJsonResponse<{ data: Record<string, number> }>(res)
    expect(body.data).toEqual({ [JE_A]: 1 })
  })

  it('never returns entries the caller did not ask about', async () => {
    enqueueAll({
      si: [
        {
          document_id: 'doc-si',
          // The SI's other FK points at an entry outside the request.
          registration_journal_entry_id: JE_C,
          payment_journal_entry_id: JE_A,
          document: { journal_entry_id: JE_C },
        },
      ],
    })
    const res = await GET(makeReq([JE_A]))
    const { body } = await parseJsonResponse<{ data: Record<string, number> }>(res)
    expect(body.data).toEqual({ [JE_A]: 1 })
    expect(body.data[JE_C]).toBeUndefined()
  })

  it('returns 500 when a lookup fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })
    const res = await GET(makeReq([JE_A]))
    expect((await parseJsonResponse(res)).status).toBe(500)
  })

  it('reports customer invoices pointing at an entry apart from document counts (#2298)', async () => {
    // JE_A: the invoice register links it directly AND a payment row points
    // at it (one invoice counted once, plus a second invoice via payment).
    // JE_B: only a payment row (a SIE-imported voucher matched to an invoice).
    // JE_C: nothing. No document anywhere: `data` stays empty.
    enqueueAll({
      invoices: [{ id: 'inv-1', journal_entry_id: JE_A }],
      payments: [
        { id: 'pay-1', invoice_id: 'inv-1', journal_entry_id: JE_A },
        { id: 'pay-2', invoice_id: 'inv-2', journal_entry_id: JE_A },
        { id: 'pay-3', invoice_id: 'inv-3', journal_entry_id: JE_B },
      ],
    })
    const res = await GET(makeReq([JE_A, JE_B, JE_C]), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: Record<string, number>
      invoice_references: Record<string, number>
    }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({})
    expect(body.invoice_references).toEqual({ [JE_A]: 2, [JE_B]: 1 })
  })

  it('never returns invoice references for entries the caller did not ask about', async () => {
    enqueueAll({
      payments: [{ id: 'pay-1', invoice_id: 'inv-1', journal_entry_id: JE_C }],
    })
    const res = await GET(makeReq([JE_A]), { params: Promise.resolve({}) })
    const { body } = await parseJsonResponse<{ invoice_references: Record<string, number> }>(res)
    expect(body.invoice_references).toEqual({})
  })

  it('returns 500 when the invoice-reference lookup fails', async () => {
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: null, error: { message: 'boom' } }) // invoices by journal_entry_id
    const res = await GET(makeReq([JE_A]), { params: Promise.resolve({}) })
    expect((await parseJsonResponse(res)).status).toBe(500)
  })
})
