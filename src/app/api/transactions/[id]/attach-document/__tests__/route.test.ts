import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

import { POST, DELETE } from '../route'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})

/** The two reads that ask who else holds the document: no other row pins it, and its inbox item is matched to none. */
function enqueueNoOtherHolder() {
  enqueue({ data: [], error: null }) // transactions pinned to the document
  enqueue({ data: [], error: null }) // inbox items of the document matched elsewhere
}

function makeReq(body: unknown, method: 'POST' | 'DELETE' = 'POST') {
  return new Request('http://localhost/api/transactions/tx-1/attach-document', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/transactions/[id]/attach-document', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(makeReq({ document_id: 'doc-1' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when the caller is a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(403)
    expect(body).toEqual({ error: 'Forbidden' })
  })

  it('returns 400 when document_id missing', async () => {
    const res = await POST(makeReq({}), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 404 when transaction not in company', async () => {
    enqueue({ data: null, error: null }) // tx fetch
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(404)
    // Failures ride the structured envelope now (sessionFailureResponse).
    expect((body as { error: { code: string } }).error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('returns 404 when document not in company', async () => {
    enqueue({ data: { id: 'tx-1' }, error: null }) // tx fetch
    enqueue({ data: null, error: null }) // doc fetch
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(404)
    expect((body as { error: { code: string } }).error.code).toBe('DOC_NOT_FOUND')
  })

  it('attaches when both rows exist', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null }) // doc fetch
    enqueueNoOtherHolder()
    enqueue({ data: { journal_entry_id: null }, error: null }) // transactions update (RETURNING)
    enqueue({ data: null, error: null }) // inbox-link best-effort update
    enqueue({ data: [], error: null }) // completion: voucher-link resolution (not bulk-booked)
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { transaction_id: string; document_id: string; journal_entry_id: string | null } }>(res)
    expect(status).toBe(200)
    expect(body.data.transaction_id).toBe('tx-1')
    expect(body.data.document_id).toBe('11111111-1111-4111-8111-111111111111')
    expect(body.data.journal_entry_id).toBeNull()
    // Unbooked tx: document_attachments is only read (doc fetch), never
    // written: no journal entry to propagate to.
    const fromCalls = mockSupabase.from.mock.calls.map((c) => c[0])
    expect(fromCalls.filter((t) => t === 'document_attachments')).toHaveLength(1)
  })

  it('propagates the link onto the verifikation when the transaction is booked', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null }) // tx fetch
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null }) // doc fetch
    enqueueNoOtherHolder()
    enqueue({ data: { journal_entry_id: 'je-1' }, error: null }) // transactions update (RETURNING)
    enqueue({ data: null, error: null }) // inbox-link best-effort update
    enqueue({ data: null, error: null }) // document_attachments propagation
    enqueue({ data: [], error: null }) // completion: matched inbox items (none)
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { journal_entry_id: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.journal_entry_id).toBe('je-1')
    // doc fetch + propagation write
    const fromCalls = mockSupabase.from.mock.calls.map((c) => c[0])
    expect(fromCalls.filter((t) => t === 'document_attachments')).toHaveLength(2)
  })

  it('skips propagation when the doc already points at the same verifikation (idempotent re-attach)', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null }) // tx fetch
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-1' }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: 'je-1' }, error: null }) // transactions update (RETURNING)
    enqueue({ data: null, error: null }) // inbox-link best-effort update
    enqueue({ data: [], error: null }) // completion: matched inbox items (none)
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)
    // No propagation write: only the doc fetch touched document_attachments.
    const fromCalls = mockSupabase.from.mock.calls.map((c) => c[0])
    expect(fromCalls.filter((t) => t === 'document_attachments')).toHaveLength(1)
  })

  it('returns 409 when the document already belongs to a different verifikation', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null }) // tx fetch
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-OTHER' }, error: null }) // doc fetch
    enqueue({ data: [], error: null }) // voucher-link check: je-OTHER anchors nothing here
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { message: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.message).toContain('annan verifikation')
  })

  it('completes the matched inbox item when the tx is anchored via a bulk-book samlingsverifikat', async () => {
    // A bulk-booked tx keeps transactions.journal_entry_id null: the
    // verifikat hangs off transaction_voucher_links. Attaching a receipt to
    // it must link the underlag to that verifikat and stamp the matched
    // inbox item, or the item strands as "linked" (the 2026-08-12 report).
    const DOC = '11111111-1111-4111-8111-111111111111'
    enqueue({ data: { id: 'tx-1', journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueueNoOtherHolder()
    enqueue({ data: { journal_entry_id: null }, error: null }) // transactions update (RETURNING)
    enqueue({ data: null, error: null }) // inbox-link best-effort update
    enqueue({ data: [{ transaction_id: 'tx-1', journal_entry_id: 'je-9' }], error: null }) // voucher links
    enqueue({ data: [{ id: 'inbox-1', document_id: DOC }], error: null }) // matched inbox items
    enqueue({ data: { journal_entry_id: null }, error: null }) // doc anchor check: free
    enqueue({ data: { id: 'je-9' }, error: null }) // linkToJournalEntry: JE ownership check
    enqueue({ data: { id: DOC, journal_entry_id: 'je-9' }, error: null }) // linkToJournalEntry: doc update
    enqueue({ data: null, error: null }) // created_journal_entry_id stamp

    const res = await POST(makeReq({ document_id: DOC }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ data: { journal_entry_id: string } }>(res)
    expect(status).toBe(200)
    // The response reports the samlingsverifikat the attach completed against.
    expect(body.data.journal_entry_id).toBe('je-9')
  })

  it('returns 409 when the verifikation period is locked during propagation', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null }) // tx fetch
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null }) // doc fetch
    enqueueNoOtherHolder()
    enqueue({ data: { journal_entry_id: 'je-1' }, error: null }) // transactions update (RETURNING)
    enqueue({ data: null, error: null }) // inbox-link best-effort update
    enqueue({ data: null, error: { message: 'cannot link document in a locked/closed fiscal period' } }) // propagation blocked
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('DOC_ATTACH_PERIOD_LOCKED')
    // The pin is saved; the rest is the one answer for a locked year, with the way forward.
    expect(body.error.message).toContain('Bilagan kopplades till transaktionen men inte till verifikationen.')
    expect(body.error.message).toContain(getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!.message_sv)
  })

  it('returns 500 with the idempotent-retry message when propagation fails', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null }) // tx fetch
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null }) // doc fetch
    enqueueNoOtherHolder()
    enqueue({ data: { journal_entry_id: 'je-1' }, error: null }) // transactions update (RETURNING)
    enqueue({ data: null, error: null }) // inbox-link best-effort update
    enqueue({ data: null, error: { message: 'boom' } }) // propagation fails
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { message: string } }>(res)
    expect(status).toBe(500)
    expect(body.error.message).toContain('idempotent')
    spy.mockRestore()
  })

  it('returns 404 when the update matches no row (concurrent delete)', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null }) // doc fetch
    enqueueNoOtherHolder()
    enqueue({ data: null, error: null }) // transactions update returns no row
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('attempts to update invoice_inbox_items.matched_transaction_id after successful attach', async () => {
    // The side effect lets the inbox UI flip an item from "needs action" to
    // "Kopplad till transaktion" without an extra round-trip.
    enqueue({ data: { id: 'tx-1', journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null }) // doc fetch
    enqueueNoOtherHolder()
    enqueue({ data: { journal_entry_id: null }, error: null }) // transactions update (RETURNING)
    enqueue({ data: null, error: null }) // inbox-link update
    enqueue({ data: [], error: null }) // completion: voucher-link resolution (not bulk-booked)

    await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    // Verify the inbox_items table was touched.
    const fromCalls = mockSupabase.from.mock.calls.map((c) => c[0])
    expect(fromCalls).toContain('invoice_inbox_items')
  })

  it('tolerates a failing inbox-link update: the document attach is the primary effect', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null }) // doc fetch
    enqueueNoOtherHolder()
    enqueue({ data: { journal_entry_id: null }, error: null }) // transactions update (RETURNING)
    enqueue({ data: null, error: { message: 'rls denied' } }) // inbox-link fails
    enqueue({ data: [], error: null }) // completion: voucher-link resolution (not bulk-booked)

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(
      makeReq({ document_id: '11111111-1111-4111-8111-111111111111' }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { transaction_id: string } }>(res)
    // Side-effect failure must not roll back the (compliant) document attach.
    expect(status).toBe(200)
    expect(body.data.transaction_id).toBe('tx-1')
    // The Supabase client resolves with { error } rather than rejecting, so
    // we additionally assert that the error was actually inspected and logged
    // (not silently dropped by a try/catch that never fires). The service
    // logs through the structured logger now, not a bare console.error tag.
    expect(spy.mock.calls.flat().join(' ')).toContain('inbox back-link failed')
    spy.mockRestore()
  })
})

// crm#1950: a document attached to another transaction kept its old row. The
// old row's pin and the inbox item matched to it both carry the document onto
// that row's verifikat when it is booked, so a document a person had moved
// away became underlag of the purchase it never belonged to.
describe('POST /api/transactions/[id]/attach-document: a document another row holds', () => {
  const DOC = '11111111-1111-4111-8111-111111111111'
  const post = () => POST(makeReq({ document_id: DOC }), createMockRouteParams({ id: 'tx-1' }))

  it('moves it here: the other unbooked row lets go of its pin and its inbox item first', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: [{ id: 'tx-old' }], error: null }) // the document is pinned on another row
    enqueue({ data: [{ matched_transaction_id: 'tx-old' }], error: null }) // and its inbox item is matched there
    enqueue({ data: [], error: null }) // bank_row_anchors: no verifikat books that row
    enqueue({ data: null, error: null }) // the other row's pin is cleared
    enqueue({ data: null, error: null }) // its inbox item is released
    enqueue({ data: { journal_entry_id: null }, error: null }) // the pin lands here (RETURNING)
    enqueue({ data: null, error: null }) // the released inbox item is matched here
    enqueue({ data: [], error: null }) // completion: voucher-link resolution (not bulk-booked)

    const res = await post()
    const { status, body } = await parseJsonResponse<{ data: { moved_from_transaction_ids: string[] } }>(res)
    expect(status).toBe(200)
    expect(body.data.moved_from_transaction_ids).toEqual(['tx-old'])

    // The booked state of the other row is the anchors view's answer.
    expect(findCalls('bank_row_anchors', 'in')).toEqual([['transaction_id', ['tx-old']]])
    // The other row is emptied before this one is pinned, and only while it still holds this document.
    expect(findCalls('transactions', 'update')).toEqual([[{ document_id: null }], [{ document_id: DOC }]])
    expect(findCalls('transactions', 'in')).toEqual([['id', ['tx-old']]])
    expect(findCalls('transactions', 'eq')).toContainEqual(['document_id', DOC])
    // The inbox item leaves the old row, then is matched to this one.
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([
      [{ matched_transaction_id: null }],
      [{ matched_transaction_id: 'tx-1' }],
    ])
    expect(findCalls('invoice_inbox_items', 'in')).toEqual([['matched_transaction_id', ['tx-old']]])
    // An item a verifikat or a supplier invoice has taken is never released.
    expect(findCalls('invoice_inbox_items', 'is')).toContainEqual(['created_journal_entry_id', null])
    expect(findCalls('invoice_inbox_items', 'is')).toContainEqual(['created_supplier_invoice_id', null])
  })

  it('releases a row only the inbox item points at: no pin to clear there', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: [], error: null }) // pinned on no other row
    enqueue({ data: [{ matched_transaction_id: 'tx-old' }], error: null }) // the inbox item is matched elsewhere
    enqueue({ data: [], error: null }) // bank_row_anchors: unbooked
    enqueue({ data: null, error: null }) // the inbox item is released
    enqueue({ data: { journal_entry_id: null }, error: null }) // the pin lands here
    enqueue({ data: null, error: null }) // the inbox item is matched here
    enqueue({ data: [], error: null }) // completion

    const { status, body } = await parseJsonResponse<{ data: { moved_from_transaction_ids: string[] } }>(await post())
    expect(status).toBe(200)
    expect(body.data.moved_from_transaction_ids).toEqual(['tx-old'])
    expect(findCalls('transactions', 'update')).toEqual([[{ document_id: DOC }]])
    expect(findCalls('invoice_inbox_items', 'update')[0]).toEqual([{ matched_transaction_id: null }])
  })

  it('re-attaching the document to the row that already pins it still takes it off the other row', async () => {
    // The repair for rows left double-linked before the fix: attach again.
    enqueue({ data: { id: 'tx-1', document_id: DOC, journal_entry_id: null }, error: null }) // tx fetch: already pinned here
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: [{ id: 'tx-old' }], error: null }) // still pinned on the old row
    enqueue({ data: [{ matched_transaction_id: 'tx-old' }], error: null }) // inbox item still matched there
    enqueue({ data: [], error: null }) // bank_row_anchors: unbooked
    enqueue({ data: null, error: null }) // old pin cleared
    enqueue({ data: null, error: null }) // inbox item released
    enqueue({ data: { journal_entry_id: null }, error: null }) // pin here (same value)
    enqueue({ data: null, error: null }) // inbox item matched here
    enqueue({ data: [], error: null }) // completion

    const { status, body } = await parseJsonResponse<{ data: { moved_from_transaction_ids: string[] } }>(await post())
    expect(status).toBe(200)
    expect(body.data.moved_from_transaction_ids).toEqual(['tx-old'])
    expect(findCalls('transactions', 'update')[0]).toEqual([{ document_id: null }])
  })

  it('answers an empty moved_from_transaction_ids when nobody else holds the document', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueueNoOtherHolder()
    enqueue({ data: { journal_entry_id: null }, error: null }) // pin
    enqueue({ data: null, error: null }) // inbox back-link
    enqueue({ data: [], error: null }) // completion

    const { status, body } = await parseJsonResponse<{ data: { moved_from_transaction_ids: string[] } }>(await post())
    expect(status).toBe(200)
    expect(body.data.moved_from_transaction_ids).toEqual([])
    // Nothing to ask the anchors view about, and nothing released.
    expect(mockSupabase.from.mock.calls.map((c) => c[0])).not.toContain('bank_row_anchors')
    expect(findCalls('transactions', 'update')).toEqual([[{ document_id: DOC }]])
  })

  it('refuses 409 when the row that holds it is booked: a posted verifikat never loses its underlag this way', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch: the link to that verifikat never landed
    enqueue({ data: [{ id: 'tx-old' }], error: null }) // pinned on another row
    enqueue({ data: [], error: null }) // no inbox item matched elsewhere
    enqueue({ data: [{ transaction_id: 'tx-old', journal_entry_id: 'je-old' }], error: null }) // a verifikat books that row
    enqueue({ data: [], error: null }) // this row's own verifikat: none (voucher links)

    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; details: Record<string, unknown> } }>(await post())
    expect(status).toBe(409)
    expect(body.error.code).toBe('DOC_ATTACH_OTHER_VERIFIKAT')
    expect(body.error.details).toMatchObject({
      document_id: DOC,
      journal_entry_id: 'je-old',
      held_by_transaction_id: 'tx-old',
      transaction_journal_entry_id: null,
    })
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
    expect(findCalls('document_attachments', 'update')).toEqual([])
  })

  it('refuses the whole move when one of several rows that hold it is booked', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: [{ id: 'tx-open' }], error: null }) // pinned on an unbooked row
    enqueue({ data: [{ matched_transaction_id: 'tx-booked' }], error: null }) // inbox item matched to a booked one
    enqueue({ data: [{ transaction_id: 'tx-booked', journal_entry_id: 'je-7' }], error: null }) // anchors
    enqueue({ data: [], error: null }) // this row's own verifikat: none

    const { status, body } = await parseJsonResponse<{ error: { code: string; details: Record<string, unknown> } }>(await post())
    expect(status).toBe(409)
    expect(body.error.details).toMatchObject({ held_by_transaction_id: 'tx-booked', journal_entry_id: 'je-7' })
    expect(findCalls('bank_row_anchors', 'in')).toEqual([['transaction_id', ['tx-open', 'tx-booked']]])
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('does not ask who else holds a document that is already this row\'s verifikat\'s underlag', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: 'je-1' }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: 'je-1' }, error: null }) // doc fetch: same verifikat
    enqueue({ data: { journal_entry_id: 'je-1' }, error: null }) // pin
    enqueue({ data: null, error: null }) // inbox back-link
    enqueue({ data: [], error: null }) // completion: matched inbox items (none)

    const { status, body } = await parseJsonResponse<{ data: { moved_from_transaction_ids: string[] } }>(await post())
    expect(status).toBe(200)
    expect(body.data.moved_from_transaction_ids).toEqual([])
    // The transactions trigger keeps every pin on a verifikat's underlag: nothing is released.
    expect(findCalls('transactions', 'update')).toEqual([[{ document_id: DOC }]])
    expect(findCalls('transactions', 'neq')).toEqual([])
  })

  it('moves it onto a booked row: the other row lets go before the document is linked to the verifikat', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: 'je-1' }, error: null }) // tx fetch: booked
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: [{ id: 'tx-old' }], error: null }) // pinned on another row
    enqueue({ data: [], error: null }) // inbox items
    enqueue({ data: [], error: null }) // bank_row_anchors: that row is unbooked
    enqueue({ data: [{ id: 'je-1', fiscal_period: { is_closed: false, locked_at: null } }], error: null }) // the verifikat's period is open
    enqueue({ data: null, error: null }) // the other row's pin is cleared
    enqueue({ data: null, error: null }) // inbox items released (none)
    enqueue({ data: { journal_entry_id: 'je-1' }, error: null }) // the pin lands here
    enqueue({ data: null, error: null }) // inbox back-link
    enqueue({ data: null, error: null }) // the document is linked to the verifikat
    enqueue({ data: [], error: null }) // completion: matched inbox items (none)

    const { status, body } = await parseJsonResponse<{ data: { journal_entry_id: string; moved_from_transaction_ids: string[] } }>(await post())
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ journal_entry_id: 'je-1', moved_from_transaction_ids: ['tx-old'] })
    // Once the document is a verifikat's underlag the trigger keeps every pin on it: the unpin comes first.
    const writes = mockSupabase.from.mock.calls.map((c) => c[0])
    expect(findCalls('transactions', 'update')[0]).toEqual([{ document_id: null }])
    expect(findCalls('document_attachments', 'update')).toHaveLength(1)
    expect(writes.lastIndexOf('document_attachments')).toBeGreaterThan(writes.indexOf('bank_row_anchors'))
  })

  it('refuses before the document leaves its row when the verifikat it would join is in a locked period', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: 'je-1' }, error: null }) // tx fetch: booked
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: [{ id: 'tx-old' }], error: null }) // pinned on another row
    enqueue({ data: [], error: null }) // inbox items
    enqueue({ data: [], error: null }) // bank_row_anchors: that row is unbooked
    enqueue({ data: [{ id: 'je-1', fiscal_period: { is_closed: true, locked_at: null } }], error: null }) // closed period

    const { body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en: string; remediation: { description: string } }
    }>(await post())
    // The published code, with the one answer for a locked year in both
    // languages and as its next step.
    const answer = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.message).toBe(answer.message_sv)
    expect(body.error.message_en).toBe(answer.message_en)
    expect(body.error.remediation).toEqual(answer.remediation)
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
    expect(findCalls('document_attachments', 'update')).toEqual([])
  })

  it('fails closed when it cannot read who holds the document: nothing is written', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: null, error: { message: 'statement timeout' } }) // pins read fails
    enqueue({ data: [], error: null }) // inbox items read

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { status } = await parseJsonResponse(await post())
    expect(status).toBe(500)
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
    spy.mockRestore()
  })

  it('fails closed when the booked state of the other row cannot be read', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: [{ id: 'tx-old' }], error: null }) // pinned on another row
    enqueue({ data: [], error: null }) // inbox items
    enqueue({ data: null, error: { message: 'view unreadable' } }) // bank_row_anchors fails

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { status } = await parseJsonResponse(await post())
    expect(status).toBe(500)
    expect(findCalls('transactions', 'update')).toEqual([])
    spy.mockRestore()
  })

  it('409 and nothing pinned when a booking made the document a verifikat\'s underlag at the same moment', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: [{ id: 'tx-old' }], error: null }) // pinned on another row
    enqueue({ data: [], error: null }) // inbox items
    enqueue({ data: [], error: null }) // bank_row_anchors: unbooked when read
    enqueue({ data: null, error: { message: 'BFL_DOCUMENT_IMMUTABILITY: cannot detach or swap document' } }) // the trigger refuses the unpin

    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await post())
    expect(status).toBe(409)
    expect(body.error.code).toBe('DOC_DETACH_CONCURRENT')
    expect(body.error.message).toContain('samtidigt')
    // The unpin was the only write attempted: no release, no pin here.
    expect(findCalls('transactions', 'update')).toEqual([[{ document_id: null }]])
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
  })

  it('500 and nothing pinned here when the inbox item cannot be released from the other row', async () => {
    // A back-link left on the old row is the defect itself: the attach must
    // not report success over it. A retry finds the row through the item.
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null }) // tx fetch
    enqueue({ data: { id: DOC, journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: [{ id: 'tx-old' }], error: null }) // pinned on another row
    enqueue({ data: [{ matched_transaction_id: 'tx-old' }], error: null }) // inbox item matched there
    enqueue({ data: [], error: null }) // bank_row_anchors: unbooked
    enqueue({ data: null, error: null }) // old pin cleared
    enqueue({ data: null, error: { code: '42501', message: 'rls denied: row values here' } }) // release fails

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await post())
    expect(status).toBe(500)
    expect(body.error.code).toBe('DOC_DETACH_INBOX_UNLINK_FAILED')
    expect(findCalls('transactions', 'update')).toEqual([[{ document_id: null }]])
    const logged = spy.mock.calls.flat().join(' ')
    expect(logged).toContain('42501')
    expect(logged).not.toContain('row values here')
    spy.mockRestore()
  })
})

describe('DELETE /api/transactions/[id]/attach-document', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await DELETE(makeReq(null, 'DELETE'), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when the caller is a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await DELETE(makeReq(null, 'DELETE'), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(403)
    expect(body).toEqual({ error: 'Forbidden' })
  })

  it('returns 404 when transaction not in company', async () => {
    enqueue({ data: null, error: null }) // tx fetch
    const res = await DELETE(makeReq(null, 'DELETE'), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(404)
    // Failures ride the structured envelope now (sessionFailureResponse).
    expect((body as { error: { code: string } }).error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('returns 409 when document is already on a journal entry', async () => {
    enqueue({ data: { id: 'tx-1', document_id: 'doc-1' }, error: null }) // tx fetch
    enqueue({ data: { journal_entry_id: 'je-1' }, error: null }) // doc fetch
    const res = await DELETE(makeReq(null, 'DELETE'), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { message: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.message).toContain('verifikation')
    // Nothing is written on the immutability path.
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('clears document_id when no journal entry link', async () => {
    enqueue({ data: { id: 'tx-1', document_id: 'doc-1' }, error: null }) // tx fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: null, error: null }) // inbox unlink
    enqueue({ data: { id: 'tx-1' }, error: null }) // pin CAS (RETURNING id)
    const res = await DELETE(makeReq(null, 'DELETE'), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ data: { document_id: string | null } }>(res)
    expect(status).toBe(200)
    expect(body.data.document_id).toBeNull()
  })

  it('clears document_id when no doc was attached', async () => {
    enqueue({ data: { id: 'tx-1', document_id: null }, error: null }) // tx fetch
    enqueue({ data: null, error: null }) // inbox unlink
    enqueue({ data: { id: 'tx-1' }, error: null }) // pin CAS
    const res = await DELETE(makeReq(null, 'DELETE'), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)
    // The back-link is released even with nothing pinned (a stale item from
    // the replace path would re-anchor just the same), and the CAS then
    // requires the pin to still be empty.
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ matched_transaction_id: null }]])
    expect(findCalls('transactions', 'is')).toContainEqual(['document_id', null])
  })

  it('releases the inbox back-link BEFORE the pin, scoped by transaction (else booking re-anchors it)', async () => {
    // propagateUnderlagForBookedTransaction selects inbox items by
    // matched_transaction_id at categorize time; a stale back-link would pin
    // the rejected receipt onto the new verifikation as immutable underlag.
    enqueue({ data: { id: 'tx-1', document_id: 'doc-1' }, error: null }) // tx fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: null, error: null }) // inbox unlink
    enqueue({ data: { id: 'tx-1' }, error: null }) // pin CAS
    const res = await DELETE(makeReq(null, 'DELETE'), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ matched_transaction_id: null }]])
    const eqArgs = findCalls('invoice_inbox_items', 'eq')
    // Scoped by transaction (unique index: at most one item points here), not
    // by the pinned doc, so a stale item from the replace path is cleared too.
    expect(eqArgs).toContainEqual(['matched_transaction_id', 'tx-1'])
    expect(eqArgs).toContainEqual(['company_id', 'company-1'])
    expect(eqArgs).not.toContainEqual(['document_id', 'doc-1'])
    // Items already consumed by a verifikat are left alone.
    expect(findCalls('invoice_inbox_items', 'is')).toContainEqual(['created_journal_entry_id', null])
    // Order: the unlink table is touched before the pin update.
    const tables = mockSupabase.from.mock.calls.map((c) => c[0])
    expect(tables.indexOf('invoice_inbox_items')).toBeLessThan(tables.lastIndexOf('transactions'))
    // Compare-and-set: the pin is cleared only if it is still doc-1.
    expect(findCalls('transactions', 'eq')).toContainEqual(['document_id', 'doc-1'])
    expect(findCalls('transactions', 'update')).toEqual([[{ document_id: null }]])
  })

  it('refuses with 409 when the pin changed under us (concurrent re-attach)', async () => {
    // Interleaving: we read doc-1, a POST pins doc-2 (and links its inbox
    // item) before our CAS runs. Zero rows come back: the new pin is kept and
    // the caller is told nothing happened, instead of a success for a state
    // that is now "doc-2 pinned, doc-2 inbox item unlinked".
    enqueue({ data: { id: 'tx-1', document_id: 'doc-1' }, error: null }) // tx fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: null, error: null }) // inbox unlink
    enqueue({ data: null, error: null }) // pin CAS: 0 rows
    const res = await DELETE(makeReq(null, 'DELETE'), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { message: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.message).toContain('samtidigt')
  })

  it('reports a failing inbox unlink as 500 with nothing changed, logging a coded cause only', async () => {
    // A stale back-link is the exact defect the detach exists to prevent, so
    // a 200 here would hide a compliance hazard. Because the unlink runs
    // first, the pin is untouched and a retry is trivially idempotent.
    enqueue({ data: { id: 'tx-1', document_id: 'doc-1' }, error: null }) // tx fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: null, error: { code: '42501', message: 'rls denied: row values here' } }) // unlink fails
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await DELETE(makeReq(null, 'DELETE'), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { message: string } }>(res)
    expect(status).toBe(500)
    expect(body.error.message).toContain('fortfarande kopplat')
    expect(findCalls('transactions', 'update')).toEqual([])
    // Raw driver messages can quote row values: only the coded cause is logged
    // (through the structured logger since the rules moved to the service).
    const logged = spy.mock.calls.flat().join(' ')
    expect(logged).toContain('42501')
    expect(logged).not.toContain('row values here')
    spy.mockRestore()
  })
})
