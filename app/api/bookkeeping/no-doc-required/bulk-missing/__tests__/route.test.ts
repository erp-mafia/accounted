import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import { NextResponse } from 'next/server'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

const mockUser = { id: 'user-1', email: 't@t.se' }

function makeReq(body: unknown) {
  return new Request('http://localhost/api/bookkeeping/no-doc-required/bulk-missing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: mockUser, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
  ;(requireWritePermission as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
})

describe('POST /api/bookkeeping/no-doc-required/bulk-missing', () => {
  it('returns 401 when not authenticated', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(makeReq({}))
    expect((await parseJsonResponse(res)).status).toBe(401)
  })

  it('returns 403 for read-only members', async () => {
    ;(requireWritePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const res = await POST(makeReq({}))
    expect((await parseJsonResponse(res)).status).toBe(403)
  })

  it('returns 400 for a non-uuid period_id', async () => {
    const res = await POST(makeReq({ period_id: 'not-a-uuid' }))
    expect((await parseJsonResponse(res)).status).toBe(400)
  })

  it('returns 400 for a shaped-but-invalid date', async () => {
    const res = await POST(makeReq({ date_from: '9999-99-99' }))
    expect((await parseJsonResponse(res)).status).toBe(400)
  })

  it('returns 400 for an invalid series filter', async () => {
    const res = await POST(makeReq({ series: 'all' }))
    expect((await parseJsonResponse(res)).status).toBe(400)
  })

  // Queue order per candidate chunk mirrors resolveMissingUnderlagEntries:
  // documents, SI references, SI payment-row references, exemptions, then the
  // customer-invoice resolver (invoices by journal_entry_id, invoice_payments).
  it('dry_run counts only entries that are missing AND not exempt', async () => {
    enqueue({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], error: null }) // candidates
    enqueue({ data: [{ journal_entry_id: 'a' }], error: null }) // a has a document
    enqueue({ data: [], error: null }) // no SI references with docs
    enqueue({ data: [], error: null }) // no SI payment-row references
    enqueue({ data: [{ journal_entry_id: 'b' }], error: null }) // b already exempt
    enqueue({ data: [], error: null }) // no invoices pointing at the entries
    enqueue({ data: [], error: null }) // no invoice payment rows
    const res = await POST(makeReq({ dry_run: true }))
    const { status, body } = await parseJsonResponse<{ data: { count: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.count).toBe(1) // only c
  })

  it('dry_run excludes entries covered by a supplier-invoice reference with an anchored doc', async () => {
    // a: covered via supplier_invoices.registration_journal_entry_id
    // b: covered via a supplier_invoice_payments row whose SI has an anchored doc
    // c: genuinely missing
    // d: SI reference exists but its doc is UNANCHORED (deletable) → still missing
    enqueue({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], error: null }) // candidates
    enqueue({ data: [], error: null }) // no direct documents
    enqueue({
      data: [
        {
          registration_journal_entry_id: 'a',
          payment_journal_entry_id: null,
          document: { journal_entry_id: 'a' },
        },
        {
          registration_journal_entry_id: 'd',
          payment_journal_entry_id: null,
          document: { journal_entry_id: null },
        },
      ],
      error: null,
    })
    enqueue({
      data: [
        {
          journal_entry_id: 'b',
          supplier_invoice: { document_id: 'doc-1', document: { journal_entry_id: 'x' } },
        },
      ],
      error: null,
    })
    enqueue({ data: [], error: null }) // no exemptions
    enqueue({ data: [], error: null }) // no invoices pointing at the entries
    enqueue({ data: [], error: null }) // no invoice payment rows
    const res = await POST(makeReq({ dry_run: true }))
    const { status, body } = await parseJsonResponse<{ data: { count: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.count).toBe(2) // c and d
  })

  it('dry_run excludes entries a customer invoice points at (#2298)', async () => {
    // a: the invoice register links it directly (invoices.journal_entry_id)
    // b: a SIE-imported voucher matched to an invoice (invoice_payments row)
    // c: genuinely missing
    enqueue({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], error: null }) // candidates
    enqueue({ data: [], error: null }) // no direct documents
    enqueue({ data: [], error: null }) // no SI references
    enqueue({ data: [], error: null }) // no SI payment-row references
    enqueue({ data: [], error: null }) // no exemptions
    enqueue({ data: [{ id: 'inv-1', journal_entry_id: 'a' }], error: null })
    enqueue({ data: [{ id: 'pay-1', invoice_id: 'inv-2', journal_entry_id: 'b' }], error: null })
    const res = await POST(makeReq({ dry_run: true }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { count: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.count).toBe(1) // only c
  })

  it('marks the missing entries and returns the count', async () => {
    enqueue({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], error: null }) // candidates
    enqueue({ data: [], error: null }) // no documents
    enqueue({ data: [], error: null }) // no SI references with docs
    enqueue({ data: [], error: null }) // no SI payment-row references
    enqueue({ data: [{ journal_entry_id: 'a' }], error: null }) // a already exempt
    enqueue({ data: [], error: null }) // no invoices pointing at the entries
    enqueue({ data: [], error: null }) // no invoice payment rows
    enqueue({ error: null }) // helper upsert
    const res = await POST(makeReq({ period_id: null, reason: 'Importerad' }))
    const { status, body } = await parseJsonResponse<{ data: { exempted: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.exempted).toBe(2) // b and c
  })

  it('short-circuits to 0 when no candidates match the filters', async () => {
    enqueue({ data: [], error: null }) // no candidates
    const res = await POST(makeReq({ dry_run: true }))
    const { status, body } = await parseJsonResponse<{ data: { count: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.count).toBe(0)
  })
})
