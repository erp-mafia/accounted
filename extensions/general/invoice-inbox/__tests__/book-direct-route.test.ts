import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  makeInvoiceInboxItem,
} from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const createJournalEntryMock = vi.fn()
const linkToJournalEntryMock = vi.fn()

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => createJournalEntryMock(...args),
}))

vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: (...args: unknown[]) => linkToJournalEntryMock(...args),
}))

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find(
    (r) => r.method === method && r.path === path
  )!
}

function buildCtx(supabase: unknown, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
    ...overrides,
  } as ExtensionContext
}

const PERIOD_UUID = '00000000-0000-4000-8000-000000000010'
const TX_UUID = '00000000-0000-4000-8000-000000000020'

const VALID_BODY = {
  fiscal_period_id: PERIOD_UUID,
  entry_date: '2026-05-14',
  description: 'Kvitto från Spotify',
  lines: [
    { account_number: '6540', debit_amount: 79.2, credit_amount: 0 },
    { account_number: '2641', debit_amount: 19.8, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 99 },
  ],
}

describe('POST /items/:id/book-direct', () => {
  const route = findRoute('POST', '/items/:id/book-direct')

  beforeEach(() => {
    createJournalEntryMock.mockReset()
    linkToJournalEntryMock.mockReset()
    createJournalEntryMock.mockResolvedValue({
      id: 'je-1',
      voucher_series: 'A',
      voucher_number: 42,
    })
    linkToJournalEntryMock.mockResolvedValue({ id: 'doc-1' })
  })

  it('returns 401 when no context', async () => {
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, undefined)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 when body is invalid (unbalanced is checked by engine; here we check zod-level)', async () => {
    const { supabase } = createQueuedMockSupabase()
    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { fiscal_period_id: 'not-a-uuid' },
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 404 when inbox item not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 409 when item already linked to a supplier invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        created_supplier_invoice_id: 'si-1',
      }),
    })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
  })

  it('returns 409 when item already has a journal entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        created_journal_entry_id: 'je-existing',
      }),
    })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
  })

  it('books a standalone entry and links the document', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // 1. fetch inbox item
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    // 2. update inbox item (status=confirmed, created_journal_entry_id)
    enqueue({ data: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body).toMatchObject({
      data: { journal_entry: { id: 'je-1' }, transaction_id: null },
    })
    expect(createJournalEntryMock).toHaveBeenCalledTimes(1)
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        source_type: 'inbox_item',
        fiscal_period_id: PERIOD_UUID,
      }),
    )
    expect(linkToJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'doc-1',
      'je-1',
    )
  })

  it('returns 404 when transaction_id is provided but not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({}) })
    enqueue({ data: null })  // transaction lookup

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, transaction_id: TX_UUID },
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('returns 409 when transaction is already booked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({}) })
    enqueue({ data: { id: TX_UUID, journal_entry_id: 'je-old' } })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, transaction_id: TX_UUID },
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  // ── WhatsApp channel-context notes default ──────────────────
  // The chat answers (representation deltagare + syfte, sender note) reach
  // the verifikat even through callers that never saw the chat: absent/empty
  // request notes default server-side to the rendered channel_context.

  const WA_CONTEXT = {
    channel: 'whatsapp' as const,
    caption: 'Kvitto lunch',
    representation: {
      participants: [
        { name: 'Anna Berg', company: 'Volvo' },
        { name: 'Jakob W', company: null },
      ],
      purpose: 'uppföljning av avtal',
      event_date: null,
      raw_answer: 'Anna Berg Volvo och jag, uppföljning av avtal',
      answered_at: '2026-08-01T12:00:00Z',
    },
  }

  it('defaults notes to the rendered channel context when the request sends none', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        document_id: 'doc-1',
        source: 'whatsapp',
        channel_context: WA_CONTEXT,
      }),
    })
    enqueue({ data: null }) // inbox item update

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY, // no notes field
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        notes: 'Representation: Anna Berg (Volvo), Jakob W · Syfte: uppföljning av avtal',
      }),
    )
  })

  it('lets caller-supplied notes win over the channel context', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        document_id: 'doc-1',
        source: 'whatsapp',
        channel_context: WA_CONTEXT,
      }),
    })
    enqueue({ data: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, notes: 'Min egen anteckning' },
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ notes: 'Min egen anteckning' }),
    )
  })

  // Regression (adversarial review): the dialog prefills the chat note, so a
  // user who reads it, disagrees and DELETES it submits notes:''. Falling back
  // to the rendered context on any falsy value re-attached the deleted text to
  // a posted verifikat, where only a formal rättelse can remove it. Presence
  // of the field, not its truthiness, decides.
  it('honors an explicitly cleared notes field instead of resurrecting the chat context', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        document_id: 'doc-1',
        source: 'whatsapp',
        channel_context: WA_CONTEXT,
      }),
    })
    enqueue({ data: null }) // inbox item update

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, notes: '' },
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ notes: undefined }),
    )
    const [, , , input] = createJournalEntryMock.mock.calls[0] as [unknown, string, string, { notes?: string }]
    expect(input.notes ?? '').not.toContain('Representation')
  })

  // Whitespace is a cleared field too, not "no opinion".
  it('treats a whitespace-only notes value as cleared', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        document_id: 'doc-1',
        source: 'whatsapp',
        channel_context: WA_CONTEXT,
      }),
    })
    enqueue({ data: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, notes: '   ' },
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ notes: undefined }),
    )
  })

  // The photo caption is unreviewed chat text: this default runs for callers
  // that never saw it (MCP, API), so it must not reach the verifikat.
  it('never defaults an unreviewed caption onto the verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        document_id: 'doc-1',
        source: 'whatsapp',
        channel_context: {
          channel: 'whatsapp',
          caption: 'kvittot från igår, Annas sjukbesök, hon betalade',
        },
      }),
    })
    enqueue({ data: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY, // no notes field: the server default applies
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ notes: undefined }),
    )
  })

  it('leaves notes undefined when the item has no channel context', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    enqueue({ data: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ notes: undefined }),
    )
  })

  it('books with transaction link: source_type=bank_transaction, source_id=transaction.id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    enqueue({ data: { id: TX_UUID, journal_entry_id: null } })
    enqueue({ data: null })  // transaction update
    enqueue({ data: null })  // inbox item update

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, transaction_id: TX_UUID },
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body).toMatchObject({
      data: { transaction_id: TX_UUID },
    })
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        source_type: 'bank_transaction',
        source_id: TX_UUID,
      }),
    )
  })

  it('keeps an existing match when the caller omits transaction_id', async () => {
    // A caller that merely forgets the field used to unpick a match somebody
    // had already made: the verifikat posted standalone, the bank line stayed
    // unbooked, and nothing on screen said so. Forgetting a field must not
    // undo work.
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({ document_id: 'doc-1', matched_transaction_id: TX_UUID }),
    })
    enqueue({ data: null }) // inbox item update

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY, // no transaction_id
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    expect(res.status).toBe(200)

    // The preserved match must also be BOOKED. Keeping the link while leaving
    // the bank line open is the worse half of the bug: the item looks resolved
    // and the transaction stays outstanding forever.
    const txUpdate = calls.find(
      (c: { method: string; args?: unknown[] }) =>
        c.method === 'update' &&
        typeof c.args?.[0] === 'object' &&
        c.args?.[0] !== null &&
        'journal_entry_id' in (c.args[0] as Record<string, unknown>),
    )
    expect(txUpdate, 'the preserved transaction was never booked').toBeTruthy()

    const update = calls.find(
      (c: { method: string; args?: unknown[] }) =>
        c.method === 'update' &&
        typeof c.args?.[0] === 'object' &&
        c.args?.[0] !== null &&
        'created_journal_entry_id' in (c.args[0] as Record<string, unknown>),
    )
    expect((update?.args?.[0] as Record<string, unknown>).matched_transaction_id).toBe(TX_UUID)
  })
})
