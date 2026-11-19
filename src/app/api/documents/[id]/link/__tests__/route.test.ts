import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

// The real rules run; a test can answer one call itself (a copy reads and
// archives file bytes).
vi.mock('@/lib/documents/link-document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents/link-document')>()
  return { ...actual, linkDocumentToVoucher: vi.fn(actual.linkDocumentToVoucher) }
})

import { POST } from '../route'
import { linkDocumentToVoucher } from '@/lib/documents/link-document'
import { requireWritePermission } from '@/lib/auth/require-write'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { NextResponse } from 'next/server'

const mockUser = { id: 'user-1', email: 'test@test.se' }

// Body fields are uuid-validated (LinkDocumentSchema): request fixtures must
// be real UUIDs. The enqueue mock rows keep their short ids; the queued mock
// doesn't correlate request input with mocked output.
const JE_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_JE_ID = '22222222-2222-4222-8222-222222222222'
const INBOX_ID = '33333333-3333-4333-8333-333333333333'
const TX_ID = '44444444-4444-4444-8444-444444444444'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true })
})

function makeReq(body: unknown) {
  return new Request('http://localhost/api/documents/doc-1/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/documents/[id]/link', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeReq({ journal_entry_id: JE_ID }), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 403 when caller has read-only role', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    })
    const res = await POST(makeReq({ journal_entry_id: JE_ID }), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(403)
  })

  it('rejects a missing journal_entry_id', async () => {
    const res = await POST(makeReq({}), createMockRouteParams({ id: 'doc-1' }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a non-uuid journal_entry_id', async () => {
    const res = await POST(
      makeReq({ journal_entry_id: 'not-a-uuid' }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  // Query order (lib/documents/link-document.ts): the document and the
  // verifikat, the holder when another verifikat has the document, the
  // period, then linkToJournalEntry (verifikat check, update) and the stamp
  // of the inbox item that carries the document.
  function enqueueChecks(document: Record<string, unknown> = { id: 'doc-1', journal_entry_id: null, journal_entry_line_id: null }) {
    enqueue({ data: { file_name: 'x.pdf', mime_type: 'application/pdf', ...document } }) // document
    enqueue({ data: { id: JE_ID, status: 'posted', fiscal_period_id: null } }) // verifikat
  }
  function enqueueLink() {
    enqueue({ data: { id: JE_ID } }) // linkToJournalEntry: verifikat company check
    enqueue({ data: { id: 'doc-1', journal_entry_id: JE_ID, file_name: 'x.pdf' } }) // link update
  }

  it('links the document and stamps the inbox item that carries it, not the one inbox_item_id names', async () => {
    enqueueChecks()
    enqueueLink()
    enqueue({ data: [{ id: 'inbox-carrying-doc-1' }] }) // inbox stamp

    const res = await POST(
      makeReq({ journal_entry_id: JE_ID, inbox_item_id: INBOX_ID }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('doc-1')
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE_ID }]])
    const inboxEq = findCalls('invoice_inbox_items', 'eq')
    expect(inboxEq).toContainEqual(['document_id', 'doc-1'])
    expect(inboxEq).not.toContainEqual(['id', INBOX_ID])
  })

  it('stamps the inbox item carrying the document without inbox_item_id too (one inbox rule on every door)', async () => {
    enqueueChecks()
    enqueueLink()
    enqueue({ data: [] }) // inbox stamp

    const res = await POST(
      makeReq({ journal_entry_id: JE_ID }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(1)
  })

  it('pins the document to the transaction when transaction_id is given', async () => {
    enqueueChecks()
    enqueueLink()
    enqueue({ data: [] }) // inbox stamp
    enqueue({ data: null }) // transaction pin update

    const res = await POST(
      makeReq({ journal_entry_id: JE_ID, transaction_id: TX_ID }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('transactions')
  })

  it('does not touch transactions when no transaction_id is given', async () => {
    enqueueChecks()
    enqueueLink()
    enqueue({ data: [] }) // inbox stamp

    const res = await POST(
      makeReq({ journal_entry_id: JE_ID }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(mockSupabase.from).not.toHaveBeenCalledWith('transactions')
  })

  it('tolerates a failing transaction pin: the JE link is the primary effect', async () => {
    enqueueChecks()
    enqueueLink()
    enqueue({ data: [] }) // inbox stamp
    enqueue({ data: null, error: { message: 'rls denied' } }) // transaction pin fails

    const res = await POST(
      makeReq({ journal_entry_id: JE_ID, transaction_id: TX_ID }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(res)

    // The pin is row-level UX; its failure must not fail the (compliant) link.
    expect(status).toBe(200)
    expect(body.data.id).toBe('doc-1')
  })

  it('maps the document period-lock trigger to DOC_UPLOAD_PERIOD_LOCKED with its way forward', async () => {
    enqueueChecks()
    enqueue({ data: { id: JE_ID } }) // linkToJournalEntry: verifikat company check
    enqueue({
      data: null,
      error: { code: 'P0001', message: 'Cannot attach documents to entries in a locked/closed fiscal period' },
    })
    const res = await POST(
      makeReq({ journal_entry_id: JE_ID, inbox_item_id: INBOX_ID }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
    expect(body.error.message).toBe(getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!.message_sv)
    // The inbox stamp must not run when the link itself failed.
    expect(mockSupabase.from).not.toHaveBeenCalledWith('invoice_inbox_items')
  })

  it('refuses a verifikat in a locked period with DOC_UPLOAD_PERIOD_LOCKED before the write', async () => {
    enqueue({ data: { id: 'doc-1', journal_entry_id: null, journal_entry_line_id: null, file_name: 'x.pdf' } })
    enqueue({ data: { id: JE_ID, status: 'posted', fiscal_period_id: 'fp-1' } })
    enqueue({ data: { id: 'fp-1', period_start: '2025-01-01', is_closed: false, locked_at: '2026-01-31T00:00:00Z', closed_externally: false, closing_entry_id: null } })

    const res = await POST(makeReq({ journal_entry_id: JE_ID }), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
    expect(body.error.message).toBe(getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!.message_sv)
    expect(findCalls('document_attachments', 'update')).toHaveLength(0)
  })

  it('maps an already-linked error to DOC_LINK_ALREADY_LINKED', async () => {
    enqueueChecks()
    enqueue({ data: { id: JE_ID } }) // linkToJournalEntry: verifikat company check
    enqueue({
      data: null,
      error: { message: 'document already linked to another entry' },
    })
    const res = await POST(
      makeReq({ journal_entry_id: JE_ID }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('DOC_LINK_ALREADY_LINKED')
  })

  it('answers 409 DOC_LINK_ALREADY_LINKED, not a 500, when the immutability trigger refuses a write that raced the check', async () => {
    // The trigger refuses any change of a set journal_entry_id whatever the
    // holder's status (agent feedback seq 932068): its raw text used to fall
    // through to DOC_LINK_FAILED.
    enqueueChecks()
    enqueue({ data: { id: JE_ID } }) // linkToJournalEntry: verifikat company check
    enqueue({
      data: null,
      error: {
        message:
          'BFL_DOCUMENT_IMMUTABILITY: cannot clear or change journal_entry_id on document doc-1 once set (BFL 5 kap 6 §). Reverse the journal entry first.',
      },
    })
    const res = await POST(
      makeReq({ journal_entry_id: JE_ID }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('DOC_LINK_ALREADY_LINKED')
  })

  it('refuses a document held by another verifikat (reversed) before the write, naming the holder', async () => {
    enqueueChecks({ id: 'doc-1', journal_entry_id: OTHER_JE_ID, journal_entry_line_id: null })
    enqueue({ data: { status: 'reversed', voucher_series: 'A', voucher_number: 57 } }) // holder

    const res = await POST(makeReq({ journal_entry_id: JE_ID }), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details?: Record<string, unknown> } }>(res)

    expect(status).toBe(409)
    expect(body.error.code).toBe('DOC_LINK_ALREADY_LINKED')
    expect(findCalls('document_attachments', 'update')).toHaveLength(0)
    expect(mockSupabase.from).not.toHaveBeenCalledWith('invoice_inbox_items')
  })

  it('refuses a line of another verifikat with 404 NOT_FOUND, writing nothing', async () => {
    enqueueChecks()
    enqueue({ data: null }) // the line lookup scoped to the verifikat finds nothing

    const res = await POST(
      makeReq({ journal_entry_id: JE_ID, journal_entry_line_id: '55555555-5555-4555-8555-555555555555' }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(findCalls('document_attachments', 'update')).toHaveLength(0)
  })

  it('rejects a journal entry outside the active company with DOC_LINK_ENTRY_NOT_FOUND', async () => {
    // The company-scoped lookup finds no row: same result whether the id is
    // bogus or belongs to another tenant. The document must never be updated.
    enqueue({ data: { id: 'doc-1', journal_entry_id: null, journal_entry_line_id: null, file_name: 'x.pdf' } })
    enqueue({ data: null }) // journal entry company check: no match
    const res = await POST(
      makeReq({ journal_entry_id: OTHER_JE_ID }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('DOC_LINK_ENTRY_NOT_FOUND')
    expect(findCalls('document_attachments', 'update')).toHaveLength(0)
    expect(mockSupabase.from).not.toHaveBeenCalledWith('invoice_inbox_items')
  })

  describe('copy: true, one underlag on several verifikat (crm#1171 item 9)', () => {
    const copyResult = {
      ok: true as const,
      dryRun: false as const,
      target: {
        document: { id: 'doc-1', file_name: 'kontoutdrag.pdf', mime_type: 'application/pdf', journal_entry_id: OTHER_JE_ID, journal_entry_line_id: null },
        entry: { id: JE_ID, entry_date: '2026-09-22', description: 'Bankavgift', voucher_series: 'A', voucher_number: 23, status: 'posted', fiscal_period_id: null },
      },
      document: { id: 'copy-1', file_name: 'kontoutdrag.pdf', journal_entry_id: JE_ID, journal_entry_line_id: null } as never,
      copy_of_document_id: 'doc-1',
    }

    it('passes copy and the signed-in user to the shared rules and answers with the copy and its source', async () => {
      vi.mocked(linkDocumentToVoucher).mockResolvedValueOnce(copyResult)

      const res = await POST(makeReq({ journal_entry_id: JE_ID, copy: true }), createMockRouteParams({ id: 'doc-1' }))
      const { status, body } = await parseJsonResponse<{ data: { id: string }; copy_of_document_id: string | null }>(res)

      expect(status).toBe(200)
      expect(body.data.id).toBe('copy-1')
      expect(body.copy_of_document_id).toBe('doc-1')
      expect(vi.mocked(linkDocumentToVoucher)).toHaveBeenCalledWith(
        mockSupabase,
        'company-1',
        expect.objectContaining({ document_id: 'doc-1', journal_entry_id: JE_ID, copy: true }),
        { userId: 'user-1' },
      )
    })

    it('pins the copy, the row on this verifikat, to the transaction', async () => {
      vi.mocked(linkDocumentToVoucher).mockResolvedValueOnce(copyResult)
      enqueue({ data: null }) // transaction pin update

      const res = await POST(makeReq({ journal_entry_id: JE_ID, copy: true, transaction_id: TX_ID }), createMockRouteParams({ id: 'doc-1' }))

      expect(res.status).toBe(200)
      expect(findCalls('transactions', 'update')).toEqual([[{ document_id: 'copy-1' }]])
    })

    it('answers a plain link with copy_of_document_id null', async () => {
      enqueue({ data: { id: 'doc-1', file_name: 'x.pdf', mime_type: 'application/pdf', journal_entry_id: null, journal_entry_line_id: null } })
      enqueue({ data: { id: JE_ID, status: 'posted', fiscal_period_id: null } })
      enqueue({ data: { id: JE_ID } })
      enqueue({ data: { id: 'doc-1', journal_entry_id: JE_ID, file_name: 'x.pdf' } })
      enqueue({ data: [] }) // inbox stamp

      const res = await POST(makeReq({ journal_entry_id: JE_ID, copy: true }), createMockRouteParams({ id: 'doc-1' }))
      const { status, body } = await parseJsonResponse<{ data: { id: string }; copy_of_document_id: string | null }>(res)

      expect(status).toBe(200)
      expect(body.data.id).toBe('doc-1')
      expect(body.copy_of_document_id).toBeNull()
    })

    it('rejects a copy flag that is not a boolean', async () => {
      const res = await POST(makeReq({ journal_entry_id: JE_ID, copy: 'yes' }), createMockRouteParams({ id: 'doc-1' }))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
      expect(status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })
  })
})
