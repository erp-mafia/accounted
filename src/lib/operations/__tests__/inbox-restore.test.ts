/**
 * Senast borttagna (lib/operations/inbox-restore.ts): the list of deleted
 * inbox items that can be put back, and putting one back as it was deleted,
 * once. Rows answer as PostgREST would (createRowsMockSupabase applies the
 * filters), so a test says what state the company is in, not which read
 * comes when.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRowsMockSupabase } from '@/tests/helpers'
import { listRemovedInboxItems, restoreInboxItem, REMOVED_INBOX_ITEMS_LIMIT } from '../inbox-restore'
import { proposeBankMatchForInboxItem } from '../inbox-bank-match'
import { USAGE_SOURCES } from '@/lib/usage/counters'
import type { OperationContext } from '../types'

vi.mock('../inbox-bank-match', () => ({ proposeBankMatchForInboxItem: vi.fn(async () => undefined) }))

type Row = Record<string, unknown>

const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_COMPANY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER = '11111111-1111-4111-8111-111111111111'
const uuid = (n: number, family = '2') => `${family.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
const itemId = (n: number) => uuid(n, '2')
const docId = (n: number) => uuid(n, 'd')

const READING = {
  supplier: { name: 'Nordisk Kontorsservice AB', orgNumber: '556000-0001' },
  invoice: { invoiceNumber: 'F-1', invoiceDate: '2026-11-02', currency: 'SEK' },
  totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
  lineItems: [{ description: 'Pärmar' }],
  purchaseCategory: 'expense.office.supplies',
}

/** An inbox item's row as it was deleted. */
function removedItem(n: number, over: Row = {}): Row {
  return {
    id: itemId(n),
    company_id: COMPANY,
    user_id: USER,
    document_id: docId(n),
    status: 'received',
    source: 'email',
    created_at: '2026-10-28T08:15:00.000Z',
    updated_at: '2026-11-03T10:00:00.000Z',
    extracted_data: READING,
    extraction_skipped: false,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    kind_hint: 'supplier_invoice',
    channel_context: { intake_source: 'intake_email' },
    email_from: 'faktura@example.test',
    email_subject: 'Faktura F-1',
    email_received_at: '2026-10-28T08:14:50.000Z',
    email_body_text: 'Hej, här kommer fakturan.',
    resend_email_id: 'mail-1',
    resend_attachment_id: 'att-1',
    raw_email_payload: { messageId: 'm-1', filename: 'faktura.pdf' },
    correlation_id: uuid(n, 'c'),
    whatsapp_message_id: null,
    error_message: null,
    routed_to_arkiv_at: null,
    routed_doc_type: null,
    bank_match_transaction_id: null,
    ...over,
  }
}

/**
 * The decision row a deletion wrote, with the columns both reads of it
 * select: the kept row, and the JSON paths the list and the lookup name.
 */
function deletion(n: number, over: { item?: Row; removedAt?: string; company?: string; actor?: string; by?: string | null } = {}): Row {
  const item = removedItem(n, over.item)
  const reading = (item.extracted_data ?? null) as Record<string, unknown> | null
  return {
    id: uuid(n, '5'),
    company_id: over.company ?? COMPANY,
    kind: 'inbox_item',
    outcome: 'dismissed',
    created_at: over.removedAt ?? `2026-11-${String(n).padStart(2, '0')}T12:00:00.000Z`,
    actor_type: over.actor ?? 'user',
    resolved_by: over.by === undefined ? USER : over.by,
    document_id: item.document_id,
    removed_item: item,
    'removed_item->>id': item.id,
    removed_item_id: item.id,
    email_from: item.email_from,
    email_subject: item.email_subject,
    supplier: reading?.supplier ?? null,
    invoice: reading?.invoice ?? null,
    totals: reading?.totals ?? null,
  }
}

const document = (n: number, over: Row = {}): Row => ({
  id: docId(n),
  company_id: COMPANY,
  file_name: `faktura-${n}.pdf`,
  sha256_hash: `hash-${n}`,
  journal_entry_id: null,
  entry: null,
  ...over,
})

function company(tables: Partial<Record<string, Row[]>>) {
  const writes: { table: string; method: string; row: unknown }[] = []
  const mock = createRowsMockSupabase(
    {
      suggestion_log: [],
      document_attachments: [],
      invoice_inbox_items: [],
      supplier_invoices: [],
      expense_claims: [],
      transactions: [],
      suppliers: [],
      ...tables,
    } as Record<string, Row[]>,
    writes,
  )
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  const ctx = { supabase: mock.supabase, companyId: COMPANY, userId: USER, log } as unknown as OperationContext
  return { ...mock, writes, ctx, log }
}

const inserted = (writes: { table: string; method: string; row: unknown }[]) =>
  writes.filter((w) => w.table === 'invoice_inbox_items' && w.method === 'insert').map((w) => w.row as Row)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listRemovedInboxItems', () => {
  it('lists what a deletion kept: the file, the reading in short, when and by whom', async () => {
    const { ctx } = company({
      suggestion_log: [deletion(3, { actor: 'mcp_oauth' })],
      document_attachments: [document(3)],
    })

    const outcome = await listRemovedInboxItems(ctx)

    expect(outcome).toEqual({
      ok: true,
      data: {
        removed_items: [
          {
            inbox_item_id: itemId(3),
            document_id: docId(3),
            file_name: 'faktura-3.pdf',
            vendor_name: 'Nordisk Kontorsservice AB',
            amount: 1250,
            currency: 'SEK',
            email_from: 'faktura@example.test',
            email_subject: 'Faktura F-1',
            removed_at: '2026-11-03T12:00:00.000Z',
            removed_by: { actor_type: 'mcp_oauth', user_id: USER },
          },
        ],
      },
    })
  })

  it('is newest first and capped at the limit', async () => {
    const numbers = Array.from({ length: 25 }, (_, i) => i + 1)
    const { ctx } = company({
      // Stored oldest first: the order is the read's, not the table's.
      suggestion_log: numbers.map((n) => deletion(n)),
      document_attachments: numbers.map((n) => document(n)),
    })

    const outcome = await listRemovedInboxItems(ctx)

    if (!outcome.ok || outcome.dryRun) throw new Error('expected a list')
    const ids = outcome.data.removed_items.map((row) => row.inbox_item_id)
    expect(ids).toHaveLength(REMOVED_INBOX_ITEMS_LIMIT)
    expect(REMOVED_INBOX_ITEMS_LIMIT).toBe(20)
    expect(ids).toEqual(numbers.slice(5).reverse().map(itemId))
  })

  it('reads only the active company and only decisions that kept an item', async () => {
    const { ctx, findCalls } = company({
      suggestion_log: [deletion(1), deletion(2, { company: OTHER_COMPANY })],
      document_attachments: [document(1), document(2, { company_id: OTHER_COMPANY })],
    })

    const outcome = await listRemovedInboxItems(ctx)

    if (!outcome.ok || outcome.dryRun) throw new Error('expected a list')
    expect(outcome.data.removed_items.map((row) => row.inbox_item_id)).toEqual([itemId(1)])
    expect(findCalls('suggestion_log', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(findCalls('suggestion_log', 'not')).toContainEqual(['removed_item', 'is', null])
    for (const table of ['document_attachments', 'invoice_inbox_items', 'supplier_invoices', 'expense_claims', 'transactions']) {
      expect(findCalls(table, 'eq'), table).toContainEqual(['company_id', COMPANY])
    }
  })

  it('shows a document once, by its latest deletion', async () => {
    const { ctx } = company({
      suggestion_log: [
        deletion(1, { removedAt: '2026-11-01T12:00:00.000Z', item: { email_subject: 'first time' } }),
        deletion(1, { removedAt: '2026-11-09T12:00:00.000Z', item: { email_subject: 'after it was put back' } }),
      ],
      document_attachments: [document(1)],
    })

    const outcome = await listRemovedInboxItems(ctx)

    if (!outcome.ok || outcome.dryRun) throw new Error('expected a list')
    expect(outcome.data.removed_items).toHaveLength(1)
    expect(outcome.data.removed_items[0]).toMatchObject({ email_subject: 'after it was put back', removed_at: '2026-11-09T12:00:00.000Z' })
  })

  it('leaves out what cannot be put back: back in the inbox, booked, or the underlag of something else', async () => {
    const { ctx } = company({
      suggestion_log: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => deletion(n)),
      document_attachments: [
        document(1),
        document(2),
        document(3),
        document(4, { journal_entry_id: 'je-4', entry: { status: 'posted' } }),
        document(5),
        document(6),
        document(7),
        // 8: its document was deleted from the archive between the two reads.
      ],
      invoice_inbox_items: [
        // 2 was put back under its own id; 3's document was filed again as a new item.
        { id: itemId(2), company_id: COMPANY, document_id: docId(2) },
        { id: uuid(99), company_id: COMPANY, document_id: docId(3) },
      ],
      supplier_invoices: [{ company_id: COMPANY, document_id: docId(5) }],
      expense_claims: [{ company_id: COMPANY, document_id: docId(6) }],
      transactions: [{ company_id: COMPANY, document_id: docId(7) }],
    })

    const outcome = await listRemovedInboxItems(ctx)

    if (!outcome.ok || outcome.dryRun) throw new Error('expected a list')
    expect(outcome.data.removed_items.map((row) => row.inbox_item_id)).toEqual([itemId(1)])
  })

  it('answers an empty list while the database has no column for the kept item yet', async () => {
    const { ctx, setTable } = company({})
    setTable('suggestion_log', { data: null, error: { code: '42703', message: 'column suggestion_log.removed_item does not exist' } })

    expect(await listRemovedInboxItems(ctx)).toEqual({ ok: true, data: { removed_items: [] } })
  })

  it('fails rather than list an item whose state it could not read', async () => {
    const { ctx, setTable } = company({ suggestion_log: [deletion(1)], document_attachments: [document(1)] })
    setTable('transactions', { data: null, error: { code: '57014', message: 'statement timeout' } })

    expect(await listRemovedInboxItems(ctx)).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR' })
  })
})

describe('restoreInboxItem', () => {
  it('puts the item back as it was deleted: its own id, reading, mail fields, door and arrival time', async () => {
    const { ctx, writes, log } = company({
      suggestion_log: [deletion(1)],
      document_attachments: [document(1)],
    })

    const outcome = await restoreInboxItem(ctx, itemId(1))

    expect(outcome).toEqual({ ok: true, data: { id: itemId(1), document_id: docId(1), restored: true } })
    expect(inserted(writes)).toEqual([
      {
        id: itemId(1),
        company_id: COMPANY,
        user_id: USER,
        document_id: docId(1),
        status: 'received',
        source: 'email',
        extracted_data: READING,
        extraction_skipped: false,
        matched_supplier_id: null,
        kind_hint: 'supplier_invoice',
        channel_context: { intake_source: 'intake_email' },
        email_from: 'faktura@example.test',
        email_subject: 'Faktura F-1',
        email_received_at: '2026-10-28T08:14:50.000Z',
        email_body_text: 'Hej, här kommer fakturan.',
        resend_email_id: 'mail-1',
        resend_attachment_id: 'att-1',
        raw_email_payload: { messageId: 'm-1', filename: 'faktura.pdf' },
        correlation_id: uuid(1, 'c'),
        error_message: null,
        created_at: '2026-10-28T08:15:00.000Z',
      },
    ])
    // Nothing but the item is written: no decision row, no document, no new reading.
    expect(writes).toHaveLength(1)
    // Usage counts the documents our AI read by the item's created_at, which comes back as it was:
    // the item stays in the month it was read in, and this month gains nothing.
    expect(USAGE_SOURCES.ai_document).toEqual([{ table: 'invoice_inbox_items', at: 'created_at', eq: { extraction_skipped: 'false' } }])
    expect(vi.mocked(proposeBankMatchForInboxItem)).toHaveBeenCalledWith(ctx.supabase, COMPANY, itemId(1), log)
  })

  it('comes back open: no bank row, no Arkiv routing, no reading in flight, no stale pointers', async () => {
    const supplier = uuid(7, '3')
    const { ctx, writes } = company({
      suggestion_log: [
        deletion(1, {
          item: {
            status: 'processing',
            matched_transaction_id: uuid(8, 'f'),
            matched_supplier_id: supplier,
            routed_to_arkiv_at: '2026-11-01T00:00:00.000Z',
            routed_doc_type: 'agreement',
            bank_match_transaction_id: uuid(8, 'f'),
            whatsapp_message_id: uuid(9, 'e'),
          },
        }),
      ],
      document_attachments: [document(1)],
      // The supplier it was matched to has been deleted since.
      suppliers: [],
    })

    const outcome = await restoreInboxItem(ctx, itemId(1))

    expect(outcome).toMatchObject({ ok: true })
    const [row] = inserted(writes)
    expect(row).toMatchObject({ status: 'received', matched_supplier_id: null })
    for (const column of ['matched_transaction_id', 'routed_to_arkiv_at', 'routed_doc_type', 'bank_match_transaction_id', 'whatsapp_message_id']) {
      expect(row, column).not.toHaveProperty(column)
    }
  })

  it('keeps the supplier it was matched to while that supplier exists, and an error item stays an error', async () => {
    const supplier = uuid(7, '3')
    const { ctx, writes } = company({
      suggestion_log: [deletion(1, { item: { status: 'error', error_message: 'Kunde inte läsas', matched_supplier_id: supplier } })],
      document_attachments: [document(1)],
      suppliers: [{ id: supplier, company_id: COMPANY }],
    })

    await restoreInboxItem(ctx, itemId(1))

    expect(inserted(writes)[0]).toMatchObject({ status: 'error', error_message: 'Kunde inte läsas', matched_supplier_id: supplier })
  })

  it('is refused the second time: the item is in the inbox', async () => {
    const { ctx, writes } = company({ suggestion_log: [deletion(1)], document_attachments: [document(1)] })

    expect(await restoreInboxItem(ctx, itemId(1))).toMatchObject({ ok: true })
    expect(await restoreInboxItem(ctx, itemId(1))).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_IN_INBOX' })
    expect(inserted(writes)).toHaveLength(1)
  })

  it('answers the same when two calls race past the checks and meet on the primary key', async () => {
    const { ctx, setTable } = company({ suggestion_log: [deletion(1)], document_attachments: [document(1)] })
    // Both reads find no item; the insert is refused by invoice_inbox_items_pkey.
    setTable('invoice_inbox_items', (chain) =>
      chain.some((call) => call.method === 'insert')
        ? { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "invoice_inbox_items_pkey"' } }
        : { data: [] },
    )

    expect(await restoreInboxItem(ctx, itemId(1))).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_IN_INBOX' })
    expect(vi.mocked(proposeBankMatchForInboxItem)).not.toHaveBeenCalled()
  })

  it('is refused when the document was filed again as another item', async () => {
    const { ctx, writes } = company({
      suggestion_log: [deletion(1)],
      document_attachments: [document(1)],
      invoice_inbox_items: [{ id: uuid(99), company_id: COMPANY, document_id: docId(1) }],
    })

    expect(await restoreInboxItem(ctx, itemId(1))).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_IN_INBOX' })
    expect(writes).toHaveLength(0)
  })

  it('is refused when the document has been booked since, and names the verifikat', async () => {
    const { ctx, writes } = company({
      suggestion_log: [deletion(1)],
      document_attachments: [document(1, { journal_entry_id: 'je-1', entry: { status: 'posted' } })],
    })

    expect(await restoreInboxItem(ctx, itemId(1))).toEqual({
      ok: false,
      code: 'INBOX_ITEM_RESTORE_BOOKED',
      details: { journal_entry_id: 'je-1' },
    })
    expect(writes).toHaveLength(0)
  })

  it('is allowed when the verifikat that held the document is reversed: nothing books it any more', async () => {
    const { ctx } = company({
      suggestion_log: [deletion(1)],
      document_attachments: [document(1, { journal_entry_id: 'je-1', entry: { status: 'reversed' } })],
    })

    expect(await restoreInboxItem(ctx, itemId(1))).toMatchObject({ ok: true })
  })

  it.each([
    ['supplier_invoices', 'supplier_invoice'],
    ['expense_claims', 'expense_claim'],
    ['transactions', 'bank_transaction'],
  ])('is refused when the document is the underlag of a row in %s', async (table, linkedTo) => {
    const { ctx, writes } = company({
      suggestion_log: [deletion(1)],
      document_attachments: [document(1)],
      [table]: [{ company_id: COMPANY, document_id: docId(1) }],
    })

    expect(await restoreInboxItem(ctx, itemId(1))).toEqual({
      ok: false,
      code: 'INBOX_ITEM_RESTORE_LINKED',
      details: { linked_to: linkedTo },
    })
    expect(writes).toHaveLength(0)
  })

  it('is refused when a byte-identical copy is in the inbox', async () => {
    const { ctx, writes } = company({
      suggestion_log: [deletion(1)],
      document_attachments: [document(1), document(2, { sha256_hash: 'hash-1' })],
      invoice_inbox_items: [{ id: uuid(99), company_id: COMPANY, document_id: docId(2) }],
    })

    expect(await restoreInboxItem(ctx, itemId(1))).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_DUPLICATE' })
    expect(writes).toHaveLength(0)
  })

  it('answers 404 for an item another company deleted, and reads nothing of it', async () => {
    const { ctx, writes, tables } = company({
      suggestion_log: [deletion(1, { company: OTHER_COMPANY })],
      document_attachments: [document(1, { company_id: OTHER_COMPANY })],
    })

    expect(await restoreInboxItem(ctx, itemId(1))).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_NOT_FOUND' })
    expect(tables()).toEqual(['suggestion_log'])
    expect(writes).toHaveLength(0)
  })

  it('answers 404 for an id that is no uuid without asking the database, and for one nothing was kept under', async () => {
    const { ctx, tables } = company({ suggestion_log: [deletion(1)], document_attachments: [document(1)] })

    expect(await restoreInboxItem(ctx, 'not-a-uuid')).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_NOT_FOUND' })
    expect(tables()).toEqual([])
    expect(await restoreInboxItem(ctx, itemId(2))).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_NOT_FOUND' })
  })

  it('answers 404 while the database has no column for the kept item yet', async () => {
    const { ctx, setTable } = company({})
    setTable('suggestion_log', { data: null, error: { code: '42703', message: 'column suggestion_log.removed_item does not exist' } })

    expect(await restoreInboxItem(ctx, itemId(1))).toEqual({ ok: false, code: 'INBOX_ITEM_RESTORE_NOT_FOUND' })
  })

  it('puts back the latest copy of an item that was deleted twice', async () => {
    const { ctx, writes } = company({
      suggestion_log: [
        deletion(1, { removedAt: '2026-11-01T12:00:00.000Z', item: { email_subject: 'first time' } }),
        deletion(1, { removedAt: '2026-11-09T12:00:00.000Z', item: { email_subject: 'after it was put back' } }),
      ],
      document_attachments: [document(1)],
    })

    await restoreInboxItem(ctx, itemId(1))

    expect(inserted(writes)[0]).toMatchObject({ email_subject: 'after it was put back' })
  })

  it('a dry run says what would come back and writes nothing', async () => {
    const { ctx, writes } = company({ suggestion_log: [deletion(1)], document_attachments: [document(1)] })

    const outcome = await restoreInboxItem(ctx, itemId(1), { dryRun: true })

    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        inbox_item_id: itemId(1),
        document_id: docId(1),
        inbox_item_restored: true,
        file_name: 'faktura-1.pdf',
        supplier_name: 'Nordisk Kontorsservice AB',
        amount: 1250,
        currency: 'SEK',
        email_from: 'faktura@example.test',
        email_subject: 'Faktura F-1',
        removed_at: '2026-11-01T12:00:00.000Z',
      },
    })
    expect(writes).toHaveLength(0)
    expect(vi.mocked(proposeBankMatchForInboxItem)).not.toHaveBeenCalled()
  })
})
