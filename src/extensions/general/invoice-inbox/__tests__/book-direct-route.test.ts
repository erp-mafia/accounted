import { describe, it, expect, vi, beforeEach } from 'vitest'

// The pair guard (lib/operations/inbox-pair-guard.ts, tested there): here only that the door asks and obeys.
const refuseWhenPairBookedMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/operations/inbox-pair-guard', () => ({
  refuseWhenPairBooked: (...args: unknown[]) => refuseWhenPairBookedMock(...args),
}))

import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  makeInvoiceInboxItem,
  makeTransaction,
  testRoutes,
} from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { recordInboxDecision } from '@/lib/suggestion-log/inbox'
import { recordDecisions } from '@/lib/suggestion-log/record'

const createJournalEntryMock = vi.fn()
const linkToJournalEntryMock = vi.fn()
const reverseOrphanedJournalEntryMock = vi.fn()

// suggestion_log is recorded around the booking; its own reads and writes
// are covered in lib/suggestion-log, not by this file's queued client.
vi.mock('@/lib/suggestion-log/inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/inbox')>()),
  snapshotInboxExtraction: vi.fn(async (_supabase: unknown, companyId: string, item: { id: string; document_id?: string | null }) => ({
    companyId,
    inboxItemId: item.id,
    documentId: item.document_id ?? null,
    extraction: null,
    model: null,
  })),
  recordInboxDecision: vi.fn(async () => undefined),
}))
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => createJournalEntryMock(...args),
}))

vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: (...args: unknown[]) => linkToJournalEntryMock(...args),
}))

vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: (...args: unknown[]) => reverseOrphanedJournalEntryMock(...args),
}))

// The receipt that came with the invoice follows it server-side (lib/operations/inbox-companion.ts,
// tested there); here only that the door asks, after its own writes, and only when it booked.
const followPairedReceiptMock = vi.fn()
vi.mock('@/lib/operations/inbox-companion', () => ({
  followPairedReceipt: (...args: unknown[]) => followPairedReceiptMock(...args),
}))

function findRoute(method: string, path: string) {
  return testRoutes(invoiceInboxExtension).find(
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
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
    ...overrides,
  } as ExtensionContext
}

// The item claim is a compare-and-set returning the rows it stamped: one row
// means this call won the item, none means another booking holds it.
const CLAIMED = [{ id: 'item-1' }]

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
    vi.mocked(recordInboxDecision).mockClear()
    vi.mocked(recordDecisions).mockClear()
    createJournalEntryMock.mockReset()
    linkToJournalEntryMock.mockReset()
    reverseOrphanedJournalEntryMock.mockReset()
    reverseOrphanedJournalEntryMock.mockResolvedValue(undefined)
    followPairedReceiptMock.mockReset()
    followPairedReceiptMock.mockResolvedValue({ status: 'no_receipt' })
    createJournalEntryMock.mockResolvedValue({
      id: 'je-1',
      voucher_series: 'A',
      voucher_number: 42,
    })
    linkToJournalEntryMock.mockResolvedValue({ id: 'doc-1' })
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

  it('refuses an item whose other half is booked already, naming that verifikat, before anything is posted', async () => {
    refuseWhenPairBookedMock.mockResolvedValueOnce({
      ok: false,
      code: 'INBOX_ITEM_PAIR_ALREADY_BOOKED',
      details: { inbox_item_id: 'item-1', sibling_item_id: 'item-receipt', sibling_kind: 'receipt', journal_entry_id: 'je-66', voucher: 'A66', supplier_invoice_id: null },
      messageSv: 'Kvittot från samma köp är redan bokfört på verifikat A66. Lägg till det här underlaget där i stället, så bokförs köpet inte två gånger.',
      messageEn: 'The receipt from the same purchase is booked already on voucher A66. Add this document there instead, so the purchase is not booked twice.',
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ id: 'item-1', document_id: 'doc-1' }) })
    const request = createMockRequest('/items/item-1/book-direct', { method: 'POST', body: VALID_BODY, searchParams: { _id: 'item-1' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; details: Record<string, unknown> } }>(await route.handler(request, buildCtx(supabase)))
    expect(status).toBe(409)
    expect(body.error.code).toBe('INBOX_ITEM_PAIR_ALREADY_BOOKED')
    expect(body.error.message).toContain('A66')
    expect(body.error.details).toMatchObject({ sibling_item_id: 'item-receipt', journal_entry_id: 'je-66' })
    expect(refuseWhenPairBookedMock).toHaveBeenCalledWith(supabase, 'company-1', 'item-1')
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(linkToJournalEntryMock).not.toHaveBeenCalled()
  })

  it('books a standalone entry and links the document', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // 1. fetch inbox item
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    // 2. update inbox item (status=confirmed, created_journal_entry_id)
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

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
      undefined, undefined, // the ledger adapter's commitMethod and rubricVersion positions (posting port)
    )
    expect(linkToJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'doc-1',
      'je-1',
      { link_basis: 'user_created', link_evidence: null },
    )
    // The receipt it came with follows it, on the server, in the company, as the person.
    expect(followPairedReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      'item-1',
    )
  })

  it('answers the booking even when the receipt cannot follow', async () => {
    followPairedReceiptMock.mockResolvedValue({ status: 'failed', code: 'UNKNOWN_ERROR' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    enqueue({ data: CLAIMED })
    const request = createMockRequest('/items/item-1/book-direct', { method: 'POST', body: VALID_BODY, searchParams: { _id: 'item-1' } })
    const { status, body } = await parseJsonResponse(await route.handler(request, buildCtx(supabase)))
    expect(status).toBe(200)
    expect(body).toMatchObject({ data: { journal_entry: { id: 'je-1' } } })
  })

  it('records the underlag decision with the total and VAT it booked, and no bank line', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const item = makeInvoiceInboxItem({ document_id: 'doc-1' })
    enqueue({ data: item })
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)
    createJournalEntryMock.mockResolvedValue({
      id: 'je-1',
      lines: VALID_BODY.lines.map((l) => ({ ...l })),
    })

    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    await route.handler(request, buildCtx(supabase))

    expect(vi.mocked(recordInboxDecision)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ inboxItemId: item.id, documentId: 'doc-1' }),
      expect.objectContaining({ journal_entry_id: 'je-1', fields: { total: 99, vat_amount: 19.8 } }),
      'user-1',
      [{ id: 'already_booked', result: 'pass', detail: null }, { id: 'currency', result: 'pass', detail: null }],
    )
    expect(vi.mocked(recordDecisions)).not.toHaveBeenCalled()
  })

  it('records nothing when the verifikat is refused', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    createJournalEntryMock.mockRejectedValue(new Error('locked'))

    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    await route.handler(request, buildCtx(supabase))

    expect(vi.mocked(recordInboxDecision)).not.toHaveBeenCalled()
  })

  it('posts each line with its own dimensions bag (the dialog tags lines one by one)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: null }) })
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: {
        ...VALID_BODY,
        lines: [
          { account_number: '6540', debit_amount: 79.2, credit_amount: 0, dimensions: { '1': 'KS01', '6': 'P001' } },
          { account_number: '2641', debit_amount: 19.8, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 99 },
        ],
      },
      searchParams: { _id: 'item-1' },
    })
    const { status } = await parseJsonResponse(await route.handler(request, ctx))

    expect(status).toBe(200)
    const input = createJournalEntryMock.mock.calls[0][3] as {
      lines: Array<{ account_number: string; dimensions?: Record<string, string> }>
    }
    expect(input.lines.map((l) => l.dimensions)).toEqual([{ '1': 'KS01', '6': 'P001' }, undefined, undefined])
  })

  it('rejects a malformed line dimensions bag with 400 before booking', async () => {
    const { supabase } = createQueuedMockSupabase()
    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: {
        ...VALID_BODY,
        lines: [
          { account_number: '6540', debit_amount: 99, credit_amount: 0, dimensions: { projekt: 'P001' } },
          { account_number: '1930', debit_amount: 0, credit_amount: 99 },
        ],
      },
      searchParams: { _id: 'item-1' },
    })
    const { status } = await parseJsonResponse(await route.handler(request, ctx))

    expect(status).toBe(400)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
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
    enqueue({ data: { id: TX_UUID, journal_entry_id: 'je-old', transaction_voucher_links: [] } })
    enqueue({ data: [{ id: 'je-old', status: 'posted' }] }) // the pointer's verifikat is live

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

  // A bulk-booked or split row carries a NULL pointer and is booked through a
  // bank_line voucher link. Checking only the pointer let Bokför direkt post
  // a second verifikat for the same bank row.
  it('returns 409 when the bank row is already booked through a voucher link', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({}) })
    enqueue({
      data: {
        ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -99 }),
        transaction_voucher_links: [{ journal_entry_id: 'je-bulk', role: 'bank_line' }],
      },
    })
    enqueue({ data: [{ id: 'je-bulk', status: 'posted' }] })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, transaction_id: TX_UUID },
      searchParams: { _id: 'item-1' },
    })
    const { status, body } = await parseJsonResponse(await route.handler(request, ctx))

    expect(status).toBe(409)
    expect(body).toMatchObject({
      error: { code: 'TRANSACTION_ALREADY_CATEGORIZED', details: { journal_entry_id: 'je-bulk', via: 'link' } },
    })
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('books a row whose pointer names a reversed verifikat, replacing exactly that pointer', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: null }) })
    enqueue({
      data: { ...makeTransaction({ id: TX_UUID, journal_entry_id: 'je-reversed', amount: -99 }), transaction_voucher_links: [] },
    })
    enqueue({ data: [{ id: 'je-reversed', status: 'reversed' }] })
    enqueue({ data: [{ ledger_account: '1930' }] }) // settlement account
    enqueue({ data: [{ id: TX_UUID }] }) // transaction link
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, transaction_id: TX_UUID },
      searchParams: { _id: 'item-1' },
    })
    const { status } = await parseJsonResponse(await route.handler(request, ctx))

    expect(status).toBe(200)
    expect(findCalls('transactions', 'eq')).toContainEqual(['journal_entry_id', 'je-reversed'])
  })

  // Two requests can both pass the bookable check before either links the
  // row. The loser's verifikat is posted and immutable, so it is reversed
  // through the storno service, never deleted, and the item stays unbooked.
  it('reverses the new verifikat when a concurrent booking linked the row first', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    enqueue({
      data: { ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -99 }), transaction_voucher_links: [] },
    })
    enqueue({ data: [{ ledger_account: '1930' }] }) // settlement account
    enqueue({ data: [] }) // transaction link: CAS matched no row

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, transaction_id: TX_UUID },
      searchParams: { _id: 'item-1' },
    })
    const { status, body } = await parseJsonResponse(await route.handler(request, ctx))

    expect(status).toBe(409)
    expect(body).toMatchObject({ error: { code: 'TX_CATEGORIZE_RACE' } })
    expect(findCalls('transactions', 'is')).toContainEqual(['journal_entry_id', null])
    expect(reverseOrphanedJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
      expect.any(Function), // the storno's business event, read by the posting port only while POSTING_EVENTS is on
    )
    expect(linkToJournalEntryMock).not.toHaveBeenCalled()
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
  })

  it('reverses the new verifikat when the transaction link fails', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: null }) })
    enqueue({
      data: { ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -99 }), transaction_voucher_links: [] },
    })
    enqueue({ data: [{ ledger_account: '1930' }] }) // settlement account
    enqueue({ error: { message: 'connection reset', code: '08006' } }) // transaction link

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, transaction_id: TX_UUID },
      searchParams: { _id: 'item-1' },
    })
    const { status } = await parseJsonResponse(await route.handler(request, ctx))

    expect(status).toBeGreaterThanOrEqual(400)
    expect(reverseOrphanedJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
      expect.any(Function), // the storno's business event, read by the posting port only while POSTING_EVENTS is on
    )
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
  })

  // accounted#14: an item with no bank row had no guard after the read, so
  // two calls that both passed it each kept a verifikat. The item stamp is
  // now a compare-and-set; the second claim loses and its verifikat goes.
  it('claims the item only while nothing holds it', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    enqueue({ data: CLAIMED })

    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    const { status } = await parseJsonResponse(await route.handler(request, buildCtx(supabase)))

    expect(status).toBe(200)
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([
      [{ matched_transaction_id: null, created_journal_entry_id: 'je-1' }],
    ])
    expect(findCalls('invoice_inbox_items', 'is')).toEqual([
      ['created_journal_entry_id', null],
      ['created_supplier_invoice_id', null],
    ])
    expect(reverseOrphanedJournalEntryMock).not.toHaveBeenCalled()
  })

  it('reverses the new verifikat and answers 409 when a concurrent booking claimed the item first', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    // The read sees an unbooked item: the other call has not stamped yet.
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    enqueue({ data: [] }) // item claim: compare-and-set matched no row

    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    const { status, body } = await parseJsonResponse(await route.handler(request, buildCtx(supabase)))

    expect(status).toBe(409)
    expect(body).toMatchObject({ error: { code: 'INBOX_ITEM_ALREADY_BOOKED' } })
    expect(createJournalEntryMock).toHaveBeenCalledTimes(1)
    expect(reverseOrphanedJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
      expect.any(Function), // the storno's business event, read by the posting port only while POSTING_EVENTS is on
    )
    // The winner keeps the underlag: the loser never links the document,
    // never records a decision, and never releases a claim that is not its own.
    expect(linkToJournalEntryMock).not.toHaveBeenCalled()
    expect(vi.mocked(recordInboxDecision)).not.toHaveBeenCalled()
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(1)
    // The loser's verifikat is reversed: no receipt follows it.
    expect(followPairedReceiptMock).not.toHaveBeenCalled()
  })

  it('releases its own claim and reverses the verifikat when the claim write errors', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    enqueue({ error: { message: 'connection reset', code: '08006' } }) // item claim
    enqueue({ data: null }) // release, keyed on this verifikat's id

    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY,
      searchParams: { _id: 'item-1' },
    })
    const { status } = await parseJsonResponse(await route.handler(request, buildCtx(supabase)))

    expect(status).toBeGreaterThanOrEqual(500)
    const updates = findCalls('invoice_inbox_items', 'update')
    expect(updates).toHaveLength(2)
    expect(updates[1]).toEqual([{ created_journal_entry_id: null }])
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['created_journal_entry_id', 'je-1'])
    expect(reverseOrphanedJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
      expect.any(Function), // the storno's business event, read by the posting port only while POSTING_EVENTS is on
    )
    expect(linkToJournalEntryMock).not.toHaveBeenCalled()
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
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

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
      undefined, undefined, // the ledger adapter's commitMethod and rubricVersion positions (posting port)
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
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

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
      undefined, undefined, // the ledger adapter's commitMethod and rubricVersion positions (posting port)
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
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

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
      undefined, undefined, // the ledger adapter's commitMethod and rubricVersion positions (posting port)
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
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

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
      undefined, undefined, // the ledger adapter's commitMethod and rubricVersion positions (posting port)
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
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

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
      undefined, undefined, // the ledger adapter's commitMethod and rubricVersion positions (posting port)
    )
  })

  it('leaves notes undefined when the item has no channel context', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

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
      undefined, undefined, // the ledger adapter's commitMethod and rubricVersion positions (posting port)
    )
  })

  it('books with transaction link: source_type=bank_transaction, source_id=transaction.id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1' }) })
    enqueue({ data: { ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -99 }), transaction_voucher_links: [] } })
    enqueue({ data: [{ ledger_account: '1930' }] }) // settlement account
    enqueue({ data: [{ id: TX_UUID }] })  // transaction link
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

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
    // The bank line it settles is a decision too.
    expect(vi.mocked(recordDecisions)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ companyId: 'company-1' }),
      [expect.objectContaining({ transactionId: TX_UUID, final: expect.objectContaining({ journal_entry_id: 'je-1' }) })],
      'user-1',
    )
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        source_type: 'bank_transaction',
        source_id: TX_UUID,
        bank_booking_context: [expect.objectContaining({ transaction_id: TX_UUID,
          cash_account_id: null, amount: -99, currency: 'SEK', settlement_account: '1930' })],
      }),
      undefined, undefined, // the ledger adapter's commitMethod and rubricVersion positions (posting port)
    )
  })

  // ── Accepting match on arrival's proposal ───────────────────
  // Booking the bank row the item's bank_match proposed is how a receipt's
  // proposal is accepted: the links keep the rule that proposed the pair.
  it.each([
    ['the proposed bank row records the proposing rule as link evidence', TX_UUID, { rule_id: 'inbox_bank_match:rule_amount_date' }],
    ['another bank row records none', '00000000-0000-4000-8000-000000000099', null],
  ])('booking %s', async (_label, proposedTxId, evidence) => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: {
        ...makeInvoiceInboxItem({ document_id: 'doc-1' }),
        bank_match_transaction_id: proposedTxId,
        bank_match_basis: 'rule_amount_date',
      },
    })
    enqueue({ data: { ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -99 }), transaction_voucher_links: [] } })
    enqueue({ data: [{ ledger_account: '1930' }] }) // settlement account
    enqueue({ data: [{ id: TX_UUID }] }) // transaction link
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: { ...VALID_BODY, transaction_id: TX_UUID },
      searchParams: { _id: 'item-1' },
    })
    const { status } = await parseJsonResponse(await route.handler(request, buildCtx(supabase)))
    expect(status).toBe(200)

    const [txLink] = findCalls('transactions', 'update').map((args) => args[0] as Record<string, unknown>)
    expect(txLink).toMatchObject({ journal_entry_id: 'je-1', link_basis: 'user_created', link_evidence: evidence })
    expect(linkToJournalEntryMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'doc-1',
      'je-1',
      { link_basis: 'user_created', link_evidence: evidence },
    )
  })

  // ── Foreign-currency underlag (crm#1146) ────────────────────
  // The lines are bare numbers the engine stores as SEK. A receipt read as
  // 100 EUR used to be booked from the dialog's prefill as 100 kr. Kronor
  // typed by hand are a real booking, with or without a bank row, so the
  // route refuses only the bug's own signature: a line that carries the
  // document's foreign total as its kronor amount.

  // The stored extraction (InvoiceExtractionResult), as the jsonb column holds it.
  function extraction(currency: string | undefined, total: number | null = 100): Record<string, unknown> {
    return {
      supplier: { name: 'Example Inc', orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
      invoice: { invoiceNumber: 'R-1', invoiceDate: '2026-05-14', dueDate: null, paymentReference: null, currency },
      lineItems: [],
      totals: { subtotal: null, vatAmount: 0, total },
      vatBreakdown: [],
      confidence: 1,
    }
  }

  // The document total in the kronor columns. The first is the shape that
  // was reported: no cost line, the bank credited with no bank row behind it.
  const FACE_OWNER_AND_BANK = [
    { account_number: '2893', debit_amount: 100, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 100 },
  ]
  const FACE_COST_AND_BANK = [
    { account_number: '6540', debit_amount: 100, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 100 },
  ]
  // Reverse charge worked out on the foreign figure: the total sits on the
  // cost line and on the owner's account.
  const FACE_WITH_REVERSE_CHARGE = [
    { account_number: '6540', debit_amount: 100, credit_amount: 0 },
    { account_number: '2645', debit_amount: 25, credit_amount: 0 },
    { account_number: '2614', debit_amount: 0, credit_amount: 25 },
    { account_number: '2893', debit_amount: 0, credit_amount: 100 },
  ]
  // Kronor typed by hand.
  const SEK_PRIVATE_OUTLAY = [
    { account_number: '6540', debit_amount: 1150, credit_amount: 0 },
    { account_number: '2645', debit_amount: 287.5, credit_amount: 0 },
    { account_number: '2614', debit_amount: 0, credit_amount: 287.5 },
    { account_number: '2893', debit_amount: 0, credit_amount: 1150 },
  ]
  const SEK_AGAINST_BANK = [
    { account_number: '6540', debit_amount: 1150, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1150 },
  ]

  function bookRequest(body: Record<string, unknown>) {
    return createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body,
      searchParams: { _id: 'item-1' },
    })
  }

  it.each([
    ['the owner account against the bank, no cost line', FACE_OWNER_AND_BANK],
    ['cost against the bank', FACE_COST_AND_BANK],
    ['cost against the owner account, with reverse charge on the foreign figure', FACE_WITH_REVERSE_CHARGE],
  ])('refuses the document total of a foreign underlag booked as kronor: %s', async (_label, lines) => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1', extracted_data: extraction('EUR') }) })

    const res = await route.handler(bookRequest({ ...VALID_BODY, lines }), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; details: unknown } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INBOX_BOOK_DIRECT_FX_FACE_AMOUNT')
    expect(body.error.details).toEqual({ currency: 'EUR' })
    // Swedish, names the currency and says what to do next. The dialog's
    // toast reads it through getErrorMessage, which must not swap it for a
    // generic 400 or for the registry's sentence without the currency.
    expect(body.error.message).toContain('underlagets belopp i EUR, inte kronor')
    expect(body.error.message).toContain('Ange beloppen i kronor')
    expect(body.error.message).toContain('banktransaktionen')
    expect(getErrorMessage(body, { context: 'journal_entry', statusCode: status })).toBe(body.error.message)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(linkToJournalEntryMock).not.toHaveBeenCalled()
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
    expect(vi.mocked(recordInboxDecision)).not.toHaveBeenCalled()
  })

  it.each(['usd', ' eur '])('reads the currency %j of the underlag whatever its case and padding', async (currency) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ extracted_data: extraction(currency) }) })

    const res = await route.handler(bookRequest({ ...VALID_BODY, lines: FACE_OWNER_AND_BANK }), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: unknown } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INBOX_BOOK_DIRECT_FX_FACE_AMOUNT')
    expect(body.error.details).toEqual({ currency: currency.trim().toUpperCase() })
  })

  // A bank row does not turn the receipt's figure into kronor: hand-typed and
  // template rows are not tied to the row that is picked afterwards.
  it('refuses the document total booked as kronor beside a bank row with another amount', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1', extracted_data: extraction('EUR') }) })
    enqueue({ data: { ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -1150 }), transaction_voucher_links: [] } })

    const res = await route.handler(
      bookRequest({ ...VALID_BODY, lines: FACE_COST_AND_BANK, transaction_id: TX_UUID }),
      buildCtx(supabase),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INBOX_BOOK_DIRECT_FX_FACE_AMOUNT')
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(findCalls('transactions', 'update')).toHaveLength(0)
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
  })

  // The way a receipt somebody paid privately is booked: no bank row, the
  // owner's account credited, reverse charge on the kronor amount. Most of
  // the standalone foreign bookings in production look like this.
  it('books kronor typed by hand against 2893 with reverse-charge lines, with no bank row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1', extracted_data: extraction('EUR') }) })
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const res = await route.handler(bookRequest({ ...VALID_BODY, lines: SEK_PRIVATE_OUTLAY }), buildCtx(supabase))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body).toMatchObject({ data: { journal_entry: { id: 'je-1' }, transaction_id: null } })
    const input = createJournalEntryMock.mock.calls[0][3] as {
      source_type: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.source_type).toBe('inbox_item')
    expect(input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6540', 1150, 0],
      ['2645', 287.5, 0],
      ['2614', 0, 287.5],
      ['2893', 0, 1150],
    ])
    expect(linkToJournalEntryMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'doc-1', 'je-1', { link_basis: 'user_created', link_evidence: null })
  })

  it('books kronor typed by hand against 1930, with no bank row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ extracted_data: extraction('EUR') }) })
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const res = await route.handler(bookRequest({ ...VALID_BODY, lines: SEK_AGAINST_BANK }), buildCtx(supabase))

    expect(res.status).toBe(200)
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'inbox_item' }),
      undefined, undefined, // the ledger adapter's commitMethod and rubricVersion positions (posting port)
    )
  })

  it('books a foreign underlag against its bank row at the bank row amount', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1', extracted_data: extraction('EUR') }) })
    enqueue({ data: { ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -1150 }), transaction_voucher_links: [] } })
    enqueue({ data: [{ ledger_account: '1930' }] }) // settlement account
    enqueue({ data: [{ id: TX_UUID }] }) // transaction link
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const res = await route.handler(
      bookRequest({ ...VALID_BODY, lines: SEK_AGAINST_BANK, transaction_id: TX_UUID }),
      buildCtx(supabase),
    )
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const input = createJournalEntryMock.mock.calls[0][3] as { source_type: string; bank_booking_context: unknown[] }
    expect(input.source_type).toBe('bank_transaction')
    expect(input.bank_booking_context).toEqual([
      expect.objectContaining({ transaction_id: TX_UUID, amount: -1150, currency: 'SEK', settlement_account: '1930' }),
    ])
  })

  // The bank drew exactly the figure on the receipt: the currency was read
  // wrongly, or the rate was one. With the bank row saying so, it is kronor.
  it('books the document total when the bank row it is booked against has that kronor amount', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ extracted_data: extraction('EUR') }) })
    enqueue({ data: { ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -100 }), transaction_voucher_links: [] } })
    enqueue({ data: [{ ledger_account: '1930' }] }) // settlement account
    enqueue({ data: [{ id: TX_UUID }] }) // transaction link
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const res = await route.handler(
      bookRequest({ ...VALID_BODY, lines: FACE_COST_AND_BANK, transaction_id: TX_UUID }),
      buildCtx(supabase),
    )

    expect(res.status).toBe(200)
    expect(createJournalEntryMock).toHaveBeenCalledTimes(1)
  })

  it('does not compare when no total was read from a foreign underlag', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ extracted_data: extraction('EUR', null) }) })
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const res = await route.handler(bookRequest({ ...VALID_BODY, lines: FACE_COST_AND_BANK }), buildCtx(supabase))

    expect(res.status).toBe(200)
  })

  it('refuses a foreign underlag whose bank row has no kronor amount', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ extracted_data: extraction('EUR') }) })
    enqueue({
      data: {
        ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -100, currency: 'EUR', amount_sek: null, exchange_rate: null }),
        transaction_voucher_links: [],
      },
    })

    const res = await route.handler(
      bookRequest({ ...VALID_BODY, lines: SEK_AGAINST_BANK, transaction_id: TX_UUID }),
      buildCtx(supabase),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: unknown } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('TX_MISSING_SEK_VALUE')
    expect(body.error.details).toEqual({ currency: 'EUR', transaction_id: TX_UUID })
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('books a foreign underlag against a foreign-currency bank row that stores its kronor amount', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ extracted_data: extraction('EUR') }) })
    enqueue({
      data: {
        ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -100, currency: 'EUR', amount_sek: -1150, exchange_rate: 11.5 }),
        transaction_voucher_links: [],
      },
    })
    enqueue({ data: [{ ledger_account: '1931' }] }) // settlement account
    enqueue({ data: [{ id: TX_UUID }] }) // transaction link
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const res = await route.handler(
      bookRequest({
        ...VALID_BODY,
        lines: [
          { account_number: '6540', debit_amount: 1150, credit_amount: 0 },
          { account_number: '1931', debit_amount: 0, credit_amount: 1150 },
        ],
        transaction_id: TX_UUID,
      }),
      buildCtx(supabase),
    )

    expect(res.status).toBe(200)
  })

  // A SEK underlag's own total is kronor: VALID_BODY credits the bank with
  // exactly the document total, and nothing about that changes.
  it.each([
    ['SEK', 'SEK'],
    ['lower-case sek', 'sek'],
    ['no currency read from the document', undefined],
  ])('still books a standalone verifikat for a SEK underlag at its own total (%s)', async (_label, currency) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ document_id: 'doc-1', extracted_data: extraction(currency, 99) }) })
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const res = await route.handler(bookRequest(VALID_BODY), buildCtx(supabase))
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'inbox_item' }),
      undefined, undefined, // the ledger adapter's commitMethod and rubricVersion positions (posting port)
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
    enqueue({ data: { ...makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: -99 }), transaction_voucher_links: [] } })
    enqueue({ data: [{ ledger_account: '1930' }] }) // settlement account
    enqueue({ data: [{ id: TX_UUID }] }) // transaction link
    enqueue({ data: CLAIMED }) // inbox item claim (compare-and-set)

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/book-direct', {
      method: 'POST',
      body: VALID_BODY, // no transaction_id
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    expect(res.status).toBe(200)
    expect(createJournalEntryMock.mock.calls[0][3]).toMatchObject({ source_type: 'inbox_item',
      bank_booking_context: [{ transaction_id: TX_UUID, cash_account_id: null, amount: -99,
        currency: 'SEK', settlement_account: '1930' }],
    })

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
