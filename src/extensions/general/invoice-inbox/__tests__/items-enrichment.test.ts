/**
 * GET /items and GET /items/:id: the booked-transaction enrichment.
 *
 * matched_transaction_journal_entry_id names the verifikat that booked the
 * matched transaction; underlag_status (#1548) says whether THIS item's
 * document reached it. The UI reads an item as booked only when both agree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  createPagedMockSupabase,
  createQueuedMockSupabase,
  createMockRequest,
  manyRows,
  parseJsonResponse,
  makeInvoiceInboxItem,
  testRoutes,
} from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import { bankMatchSourceKey, type BankMatchItemRow } from '@/lib/documents/inbox-bank-match'

const resolveBooked = vi.fn()
const resolveAnchoring = vi.fn()
vi.mock('@/lib/transactions/inbox-underlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/inbox-underlag')>()),
  resolveBookedJournalEntryIds: (...a: unknown[]) => resolveBooked(...a),
  resolveUnderlagAnchoring: (...a: unknown[]) => resolveAnchoring(...a),
}))

const vendorLogoUrls = vi.fn()
vi.mock('@/lib/vendor-logos/read', () => ({ vendorLogoUrls: (...a: unknown[]) => vendorLogoUrls(...a) }))

function findRoute(method: string, path: string) {
  return testRoutes(invoiceInboxExtension).find((r) => r.method === method && r.path === path)!
}

function buildCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

type EnrichedItem = {
  id: string
  matched_transaction_journal_entry_id: string | null
  underlag_status: 'anchored' | 'unlinked' | 'unlinked_locked' | 'anchored_elsewhere' | 'unknown' | null
}

const TX1 = 'tx-1'
const TX2 = 'tx-2'
const JE1 = 'je-1'
const JE2 = 'je-2'

function anchoring(entries: Record<string, 'anchored' | 'unlinked' | 'anchored_elsewhere'>) {
  return new Map(
    Object.entries(entries).map(([id, status]) => [id, { status, document_journal_entry_id: null }]),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveBooked.mockResolvedValue(new Map())
  resolveAnchoring.mockResolvedValue(new Map())
  vendorLogoUrls.mockResolvedValue(new Map())
})

describe('GET /items', () => {
  const route = findRoute('GET', '/items')
  const req = () => createMockRequest('/items', { method: 'GET' })

  it('returns 500 when the list query fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    expect((await route.handler(req(), buildCtx(supabase))).status).toBe(500)
  })

  it('derives the verifikat and the per-item underlag status for matched, unstamped items', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        makeInvoiceInboxItem({ id: 'anchored', matched_transaction_id: TX1, document_id: 'doc-a' }),
        makeInvoiceInboxItem({ id: 'unlinked', matched_transaction_id: TX1, document_id: 'doc-b' }),
        makeInvoiceInboxItem({ id: 'elsewhere', matched_transaction_id: TX2, document_id: 'doc-c' }),
        makeInvoiceInboxItem({ id: 'unbooked', matched_transaction_id: 'tx-open', document_id: 'doc-d' }),
        makeInvoiceInboxItem({ id: 'stamped', matched_transaction_id: TX1, created_journal_entry_id: JE1 }),
        makeInvoiceInboxItem({ id: 'unmatched', document_id: 'doc-e' }),
      ],
    })
    enqueue({ data: [] }) // the documents' own readings: none here
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1], [TX2, JE2]]))
    resolveAnchoring.mockResolvedValue(
      anchoring({ anchored: 'anchored', unlinked: 'unlinked', elsewhere: 'anchored_elsewhere' }),
    )

    const { status, body } = await parseJsonResponse<{ data: { items: EnrichedItem[] } }>(
      await route.handler(req(), buildCtx(supabase)),
    )
    expect(status).toBe(200)
    // The Dokument section is closed for this company (ARKIV_COMPANY_IDS unset), so the routed line gets no link.
    expect((body.data as { arkiv_section?: boolean }).arkiv_section).toBe(false)
    const byId = Object.fromEntries(body.data.items.map((i) => [i.id, i]))

    expect(byId.anchored).toMatchObject({ matched_transaction_journal_entry_id: JE1, underlag_status: 'anchored' })
    expect(byId.unlinked).toMatchObject({ matched_transaction_journal_entry_id: JE1, underlag_status: 'unlinked' })
    expect(byId.elsewhere).toMatchObject({
      matched_transaction_journal_entry_id: JE2,
      underlag_status: 'anchored_elsewhere',
    })
    expect(byId.unbooked).toMatchObject({ matched_transaction_journal_entry_id: null, underlag_status: null })
    // A stamped item is booked by its own column; the derived fields say
    // nothing more about it (the verifikat id it carries here is the shared
    // per-transaction resolution, not a per-item claim).
    expect(byId.stamped.underlag_status).toBeNull()
    expect(byId.unmatched).toMatchObject({ matched_transaction_journal_entry_id: null, underlag_status: null })

    // Only the unstamped matched transactions are resolved, once, and only
    // the items on booked ones go to the anchoring read.
    expect(resolveBooked).toHaveBeenCalledTimes(1)
    expect(resolveBooked).toHaveBeenCalledWith(expect.anything(), 'company-1', [TX1, TX2, 'tx-open'])
    expect(resolveAnchoring).toHaveBeenCalledWith(expect.anything(), 'company-1', [
      { id: 'anchored', document_id: 'doc-a', journalEntryId: JE1 },
      { id: 'unlinked', document_id: 'doc-b', journalEntryId: JE1 },
      { id: 'elsewhere', document_id: 'doc-c', journalEntryId: JE2 },
    ])
  })

  it("shows the document's own reading for an item routed in before it landed, and drops the not-read flag", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ ...makeInvoiceInboxItem({ id: 'routed', document_id: 'doc-r' }), extraction_skipped: true }, { ...makeInvoiceInboxItem({ id: 'bare', document_id: 'doc-x' }), extraction_skipped: true }] })
    enqueue({ data: [{ id: 'doc-r', extracted_data: { documentKind: 'receipt', totals: { total: 220 } } }, { id: 'doc-x', extracted_data: null }] })
    const { body } = await parseJsonResponse<{ data: { items: Array<Record<string, unknown>> } }>(await route.handler(req(), buildCtx(supabase)))
    const byId = Object.fromEntries(body.data.items.map((i) => [i.id as string, i]))
    expect(byId.routed).toMatchObject({ extracted_data: { documentKind: 'receipt' }, extraction_skipped: false })
    expect(byId.bare).toMatchObject({ extracted_data: null, extraction_skipped: true })
  })

  it("says when the AI provider could not take an empty reading, from the document's stamp in the same read", async () => {
    const empty = { supplier: { name: null }, invoice: { currency: 'SEK' }, totals: { total: null }, lineItems: [], vatBreakdown: [] }
    const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { ...makeInvoiceInboxItem({ id: 'outage', document_id: 'doc-o', extracted_data: empty, created_at: recent }), extraction_skipped: false },
        { ...makeInvoiceInboxItem({ id: 'retried', document_id: 'doc-r2', extracted_data: empty, created_at: recent }), extraction_skipped: false },
        { ...makeInvoiceInboxItem({ id: 'given-up', document_id: 'doc-g', extracted_data: empty, created_at: recent }), extraction_skipped: false },
        { ...makeInvoiceInboxItem({ id: 'unreadable', document_id: 'doc-u', extracted_data: empty, created_at: recent }), extraction_skipped: false },
        { ...makeInvoiceInboxItem({ id: 'read', document_id: 'doc-ok', extracted_data: { ...empty, totals: { total: 99 } }, created_at: recent }), extraction_skipped: false },
        { ...makeInvoiceInboxItem({ id: 'booked', document_id: 'doc-b', extracted_data: empty, created_journal_entry_id: 'je-9', created_at: recent }), extraction_skipped: false },
      ],
    })
    enqueue({
      data: [
        { id: 'doc-o', extracted_data: null, extraction_model: 'failed:provider_unavailable' },
        { id: 'doc-r2', extracted_data: null, extraction_model: 'failed:provider_unavailable:2' },
        { id: 'doc-g', extracted_data: null, extraction_model: 'failed:provider_unavailable:3' },
        { id: 'doc-u', extracted_data: null, extraction_model: 'failed:no_raw_text' },
      ],
    })
    const { body } = await parseJsonResponse<{ data: { items: Array<Record<string, unknown>> } }>(await route.handler(req(), buildCtx(supabase)))
    const byId = Object.fromEntries(body.data.items.map((i) => [i.id as string, i]))

    expect(byId.outage.reading_retry).toBe('scheduled')
    expect(byId.retried.reading_retry).toBe('scheduled_later')
    expect(byId['given-up'].reading_retry).toBe('exhausted')
    expect(byId.unreadable.reading_retry).toBeNull()
    expect(byId.read.reading_retry).toBeNull()
    expect(byId.booked.reading_retry).toBeNull()
    // One read for all of them, extended with the stamp; nothing read or booked is asked about.
    const docReads = findCalls('document_attachments', 'select')
    expect(docReads).toEqual([['id, extracted_data, extraction_model']])
    expect(findCalls('document_attachments', 'in')[0][1]).toEqual(['doc-o', 'doc-r2', 'doc-g', 'doc-u'])
    // The empty reading stays the item's: only a null one is stood in for.
    expect(byId.outage.extracted_data).toEqual(empty)
  })

  it("carries the vendor's stored icon, resolved from the supplier as read and the sender", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { ...makeInvoiceInboxItem({ id: 'telia' }), extracted_data: { supplier: { name: 'Telia Sverige AB' } }, email_from: 'faktura@telia.se' },
        { ...makeInvoiceInboxItem({ id: 'unknown' }), extracted_data: null, email_from: null, email_subject: 'Kvitto' },
      ],
    })
    vendorLogoUrls.mockResolvedValue(new Map([['telia', 'https://db.example/storage/v1/object/public/logos/vendor-icons/abc.png']]))
    const { body } = await parseJsonResponse<{ data: { items: Array<{ id: string; logo_url: string | null }> } }>(
      await route.handler(req(), buildCtx(supabase)),
    )
    expect(vendorLogoUrls).toHaveBeenCalledWith([
      { key: 'telia', name: 'Telia Sverige AB', emails: ['faktura@telia.se'] },
      { key: 'unknown', name: 'Kvitto', emails: [null] },
    ])
    const byId = Object.fromEntries(body.data.items.map((i) => [i.id, i]))
    expect(byId.telia!.logo_url).toBe('https://db.example/storage/v1/object/public/logos/vendor-icons/abc.png')
    expect(byId.unknown!.logo_url).toBeNull()
  })

  it('carries the bank row each open item looks already paid by, read for the whole list at once', async () => {
    const reading = { documentKind: 'supplier_invoice', supplier: { name: 'Leverantören AB' }, invoice: { dueDate: '2026-10-15', currency: 'SEK' }, totals: { total: 1250 } }
    const proposed = (id: string, tx: string) => {
      const row = {
        ...makeInvoiceInboxItem({ id, document_id: `doc-${id}`, extracted_data: reading as never }),
        bank_match_transaction_id: tx,
        bank_match_basis: 'rule_ocr_reference',
        bank_match_evidence_level: 'exakt',
      }
      return { ...row, bank_match_source_key: bankMatchSourceKey(row as BankMatchItemRow) }
    }
    const bankRow = (id: string) => ({ id, date: '2026-10-03', amount: -1250, currency: 'SEK', merchant_name: 'LEVERANTOREN', description: 'Betalning', journal_entry_id: null, is_ignored: false, transaction_voucher_links: [] })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [proposed('a', 'tx-a'), proposed('b', 'tx-b'), makeInvoiceInboxItem({ id: 'c', extracted_data: reading as never })] })
    enqueue({ data: [bankRow('tx-a'), { ...bankRow('tx-b'), journal_entry_id: 'je-booked' }] }) // the proposed rows, together
    enqueue({ data: [] }) // invoice payments
    enqueue({ data: [] }) // supplier payments
    enqueue({ data: [] }) // other inbox items paired with them

    const { status, body } = await parseJsonResponse<{ data: { items: Array<{ id: string; bank_match: unknown }> } }>(
      await route.handler(req(), buildCtx(supabase)),
    )
    expect(status).toBe(200)
    const byId = Object.fromEntries(body.data.items.map((i) => [i.id, i]))
    expect(byId.a!.bank_match).toMatchObject({ transaction_id: 'tx-a', amount: -1250, basis: 'rule_ocr_reference', evidence_level: 'exakt' })
    // Booked since the proposal was written: the list says nothing.
    expect(byId.b!.bank_match).toBeNull()
    expect(byId.c!.bank_match).toBeNull()
    // One read of the bank rows for the page, never one per row.
    expect(findCalls('transactions', 'select')).toHaveLength(1)
    expect(findCalls('transactions', 'in')).toEqual([['id', ['tx-a', 'tx-b']]])
  })

  it('still answers the list when the bank rows cannot be read, without proposals', async () => {
    const reading = { documentKind: 'receipt', supplier: { name: 'Clas Ohlson' }, totals: { total: 499 } }
    const row = { ...makeInvoiceInboxItem({ id: 'a', document_id: 'doc-a', extracted_data: reading as never }), bank_match_transaction_id: 'tx-a', bank_match_basis: 'rule_amount_date', bank_match_evidence_level: 'trolig' }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ ...row, bank_match_source_key: bankMatchSourceKey(row as BankMatchItemRow) }] })
    enqueue({ data: null, error: { message: 'timeout' } })
    const { status, body } = await parseJsonResponse<{ data: { items: Array<{ id: string; bank_match: unknown }> } }>(
      await route.handler(req(), buildCtx(supabase)),
    )
    expect(status).toBe(200)
    expect(body.data.items[0]!.bank_match).toBeNull()
  })

  it('reports unknown (never booked on a guess) when the anchoring read could not classify the item', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [makeInvoiceInboxItem({ id: 'i1', matched_transaction_id: TX1, document_id: 'doc-a' })] })
    enqueue({ data: [] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    // The helper's contract: absence means the document row could not be
    // read. The list must not degrade to the pre-#1548 "booked on the
    // transaction's word" reading, so it is reported explicitly.
    resolveAnchoring.mockResolvedValue(new Map())

    const { body } = await parseJsonResponse<{ data: { items: EnrichedItem[] } }>(
      await route.handler(req(), buildCtx(supabase)),
    )
    expect(body.data.items[0]).toMatchObject({
      matched_transaction_journal_entry_id: JE1,
      underlag_status: 'unknown',
    })
  })

  it('returns every item past 1,000 without a limit: the old cap of 500 hid open underlag behind booked items', async () => {
    const { supabase, findCalls } = createPagedMockSupabase({
      invoice_inbox_items: manyRows(1001, (i) => makeInvoiceInboxItem({ id: `item-${i}`, extracted_data: {} as never })),
    })

    const { status, body } = await parseJsonResponse<{ data: { items: EnrichedItem[]; count: number } }>(
      await route.handler(req(), buildCtx(supabase)),
    )

    expect(status).toBe(200)
    expect(body.data.count).toBe(1001)
    expect(findCalls('invoice_inbox_items', 'order').map((a) => a[0]).slice(0, 2)).toEqual(['created_at', 'id'])
  })

  it('answers ?scope=inbox with what the Inkorg shows, and the doors the handled items came through', async () => {
    const { supabase } = createPagedMockSupabase({
      invoice_inbox_items: [
        makeInvoiceInboxItem({ id: 'open', source: 'upload', extracted_data: {} as never }),
        ...manyRows(30, (i) => makeInvoiceInboxItem({ id: `booked-${i}`, source: 'peppol', created_journal_entry_id: `je-${i}`, extracted_data: {} as never })),
      ],
    })

    const { status, body } = await parseJsonResponse<{ data: { items: EnrichedItem[]; count: number; doors: string[] } }>(
      await route.handler(createMockRequest('/items', { method: 'GET', searchParams: { scope: 'inbox' } }), buildCtx(supabase)),
    )

    expect(status).toBe(200)
    expect(body.data.items.map((i) => i.id)).toEqual(['open'])
    expect(body.data.count).toBe(1)
    // The Peppol door stays listed although everything that came through it is booked.
    expect(body.data.doors).toEqual(expect.arrayContaining(['upload', 'peppol']))
  })

  it('still answers a small explicit limit with the newest items only', async () => {
    const { supabase } = createPagedMockSupabase({
      invoice_inbox_items: manyRows(300, (i) => makeInvoiceInboxItem({ id: `item-${i}`, extracted_data: {} as never })),
    })

    const { body } = await parseJsonResponse<{ data: { items: EnrichedItem[] } }>(
      await route.handler(createMockRequest('/items?limit=100', { method: 'GET' }), buildCtx(supabase)),
    )

    expect(body.data.items).toHaveLength(100)
    expect(body.data.items[0].id).toBe('item-0')
  })
})

describe('GET /items/:id', () => {
  const route = findRoute('GET', '/items/:id')
  const req = (id?: string) => createMockRequest(id ? `/items/${id}?_id=${id}` : '/items/x', { method: 'GET' })

  it('returns 400 without an id', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect((await route.handler(req(), buildCtx(supabase))).status).toBe(400)
  })

  it('returns 404 when the item does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect((await route.handler(req('missing'), buildCtx(supabase))).status).toBe(404)
  })

  it('derives the verifikat and underlag status for a matched, unstamped item', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ id: 'i1', matched_transaction_id: TX1, document_id: 'doc-a' }) })
    enqueue({ data: null }) // no document reading
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    resolveAnchoring.mockResolvedValue(anchoring({ i1: 'anchored_elsewhere' }))

    const { status, body } = await parseJsonResponse<{ data: EnrichedItem }>(
      await route.handler(req('i1'), buildCtx(supabase)),
    )
    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      id: 'i1',
      matched_transaction_journal_entry_id: JE1,
      underlag_status: 'anchored_elsewhere',
    })
    expect(resolveAnchoring).toHaveBeenCalledWith(expect.anything(), 'company-1', [
      { id: 'i1', document_id: 'doc-a', journalEntryId: JE1 },
    ])
  })

  it('reports unknown when the anchoring read could not classify the item', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ id: 'i1', matched_transaction_id: TX1, document_id: 'doc-a' }) })
    enqueue({ data: null }) // no document reading
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    resolveAnchoring.mockResolvedValue(new Map())

    const { body } = await parseJsonResponse<{ data: EnrichedItem }>(
      await route.handler(req('i1'), buildCtx(supabase)),
    )
    expect(body.data).toMatchObject({ matched_transaction_journal_entry_id: JE1, underlag_status: 'unknown' })
  })

  it('skips both lookups for a stamped item and reports null', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({ id: 'i1', matched_transaction_id: TX1, created_journal_entry_id: JE1 }),
    })

    const { body } = await parseJsonResponse<{ data: EnrichedItem }>(
      await route.handler(req('i1'), buildCtx(supabase)),
    )
    expect(body.data).toMatchObject({ matched_transaction_journal_entry_id: null, underlag_status: null })
    expect(resolveBooked).not.toHaveBeenCalled()
    expect(resolveAnchoring).not.toHaveBeenCalled()
  })

  it('reports null underlag status when the matched transaction is not booked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ id: 'i1', matched_transaction_id: 'tx-open', document_id: 'doc-a' }) })
    enqueue({ data: null })
    resolveBooked.mockResolvedValue(new Map())

    const { body } = await parseJsonResponse<{ data: EnrichedItem }>(
      await route.handler(req('i1'), buildCtx(supabase)),
    )
    expect(body.data).toMatchObject({ matched_transaction_journal_entry_id: null, underlag_status: null })
    expect(resolveAnchoring).not.toHaveBeenCalled()
  })
})

describe('GET /items/:id?include=reading', () => {
  const route = findRoute('GET', '/items/:id')
  const reading = {
    documentKind: 'receipt',
    supplier: { name: 'Kafé Exempel' },
    invoice: { invoiceDate: '2026-10-02', currency: 'SEK' },
    totals: { total: 148 },
  }
  const req = (query: string) => createMockRequest(`/items/i1?_id=i1${query}`, { method: 'GET' })

  it('leaves the reading out unless asked', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ id: 'i1', document_id: 'doc-a', extracted_data: reading }) })
    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await route.handler(req(''), buildCtx(supabase)))
    expect(body.data.reading).toBeUndefined()
    expect(findCall('document_extractions', 'select')).toBeUndefined()
  })

  it("adds the one reading, each field with its source and evidence", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ id: 'i1', document_id: 'doc-a', extracted_data: reading }) })
    enqueue({ data: { id: 'doc-a', mime_type: 'image/jpeg', extracted_data: reading, extraction_model: 'claude-sonnet-4-6', extracted_at: null } })
    enqueue({ data: null }) // no Arkiv record
    const { status, body } = await parseJsonResponse<{ data: { reading: Record<string, unknown> } }>(await route.handler(req('&include=reading'), buildCtx(supabase)))
    expect(status).toBe(200)
    expect(body.data.reading).toMatchObject({
      inbox_item_id: 'i1',
      fields: {
        seller_name: { value: 'Kafé Exempel', source: 'vision', evidence: 'trolig' },
        amount_due_for_payment: { value: 148, source: 'vision', evidence: 'trolig' },
      },
    })
  })

  it('answers 500 when the reading cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ id: 'i1', document_id: 'doc-a', extracted_data: reading }) })
    enqueue({ data: null, error: { message: 'boom' } })
    expect((await route.handler(req('&include=reading'), buildCtx(supabase))).status).toBe(500)
  })
})

describe('GET /items/:id bank_match', () => {
  const route = findRoute('GET', '/items/:id')
  const reading = {
    documentKind: 'receipt',
    supplier: { name: 'Clas Ohlson' },
    invoice: { invoiceDate: '2026-09-10', currency: 'SEK' },
    totals: { total: 499 },
  }
  const req = () => createMockRequest('/items/i1?_id=i1', { method: 'GET' })
  function proposed(overrides: Record<string, unknown> = {}) {
    const row = {
      ...makeInvoiceInboxItem({ id: 'i1', document_id: 'doc-a', extracted_data: reading }),
      bank_match_transaction_id: 'tx-9',
      bank_match_basis: 'rule_amount_date',
      bank_match_evidence_level: 'trolig',
      ...overrides,
    }
    return { ...row, bank_match_source_key: bankMatchSourceKey(row as BankMatchItemRow) }
  }
  const bankRow = { id: 'tx-9', date: '2026-09-12', amount: -499, currency: 'SEK', merchant_name: 'CLAS OHLSON', description: 'Kortköp', journal_entry_id: null, is_ignored: false, transaction_voucher_links: [] }

  it('null for an item with no proposal, without reading the bank', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ id: 'i1', document_id: 'doc-a', extracted_data: reading }) })
    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await route.handler(req(), buildCtx(supabase)))
    expect(body.data.bank_match).toBeNull()
    expect(findCall('transactions', 'select')).toBeUndefined()
  })

  it('answers the proposal, re-checked against the bank row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: proposed() })
    enqueue({ data: bankRow })
    enqueue({ data: [] }) // invoice payments
    enqueue({ data: [] }) // supplier payments
    enqueue({ data: [] }) // other inbox items paired with it
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await route.handler(req(), buildCtx(supabase)))
    expect(status).toBe(200)
    expect(body.data.bank_match).toEqual({
      transaction_id: 'tx-9',
      date: '2026-09-12',
      amount: -499,
      currency: 'SEK',
      counterparty: 'CLAS OHLSON',
      basis: 'rule_amount_date',
      evidence_level: 'trolig',
    })
  })

  it('null when the bank row was booked since, and the item still answers', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: proposed() })
    enqueue({ data: { ...bankRow, journal_entry_id: 'je-7' } })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await route.handler(req(), buildCtx(supabase)))
    expect(status).toBe(200)
    expect(body.data.bank_match).toBeNull()
  })
})
