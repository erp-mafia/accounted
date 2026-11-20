/**
 * An upload's document shares its inbox item's id; a mail or WhatsApp
 * arrival gives its document an id of its own. An agent that read ids off
 * gnubok_list_inbox_items sent the inbox item id as document_id, and every
 * forwarded receipt missed as document_not_found (Kvittojakten run,
 * 2026-10-29). Both link tools now link the document such an inbox item
 * holds, and say which inbox item the row came from. An id that is neither
 * stays a miss.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { toToolError } from '../tool-result'

const linkDocument = tools.find((t) => t.name === 'gnubok_link_document_to_voucher')!
const linkDocuments = tools.find((t) => t.name === 'gnubok_link_documents_to_vouchers')!

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const ACTOR = { type: 'api_key' as const }

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
/** A forwarded mail: the inbox item and the document it holds have different ids. */
const MAIL_ITEM = uuid(11)
const MAIL_DOC = uuid(12)
/** An upload: one id for both. */
const UPLOAD_DOC = uuid(21)
const UNKNOWN = uuid(99)
const A1 = uuid(201)
const A2 = uuid(202)
const A3 = uuid(203)

type Call = { method: string; args: unknown[] }
const arg = (calls: Call[], method: string, column: string) =>
  calls.find((c) => c.method === method && c.args[0] === column)?.args[1]
const single = (calls: Call[]) => calls.some((c) => c.method === 'maybeSingle' || c.method === 'single')

/** Answers each read by the id it filters on, as the database would. */
function byId<T extends { id: string }>(rows: T[]) {
  return (calls: Call[]) => {
    const eqId = arg(calls, 'eq', 'id')
    if (eqId !== undefined) return { data: rows.find((r) => r.id === eqId) ?? null }
    const inIds = (arg(calls, 'in', 'id') as string[] | undefined) ?? []
    const hits = rows.filter((r) => inIds.includes(r.id))
    return { data: single(calls) ? (hits[0] ?? null) : hits }
  }
}

const doc = (id: string) => ({
  id, file_name: `${id.slice(-2)}.pdf`, mime_type: 'application/pdf', doc_type: 'receipt',
  journal_entry_id: null, journal_entry_line_id: null,
})
const entry = (id: string, n: number) => ({
  id, entry_date: '2026-10-05', description: `Verifikat A${n}`, voucher_series: 'A', voucher_number: n,
  status: 'posted', fiscal_period_id: 'fp-2026',
})
const PERIOD = {
  id: 'fp-2026', period_start: '2026-01-01', period_end: '2026-12-31',
  is_closed: false, locked_at: null, closed_externally: false, closing_entry_id: null,
}

function setup() {
  return createTableMockSupabase({
    document_attachments: byId([doc(MAIL_DOC), doc(UPLOAD_DOC)]),
    invoice_inbox_items: byId([
      { id: MAIL_ITEM, document_id: MAIL_DOC },
      { id: UPLOAD_DOC, document_id: UPLOAD_DOC },
    ]),
    journal_entries: byId([entry(A1, 1), entry(A2, 2), entry(A3, 3)]),
    fiscal_periods: (calls: Call[]) => ({ data: single(calls) ? PERIOD : [PERIOD] }),
    // The waiting-claims read, then the insert.
    pending_operations: [{ data: [] }, { data: { id: 'op-1' } }],
    transactions: { data: [] },
  })
}

type Staged = { staged: boolean; preview: Record<string, unknown> }
type Inserted = { params: Record<string, unknown> }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_link_document_to_voucher with an inbox item id', () => {
  it('links the document a forwarded mail\'s inbox item holds and names the inbox item', async () => {
    const { supabase, findCall } = setup()

    const result = (await linkDocument.execute(
      { document_id: MAIL_ITEM, journal_entry_id: A1 }, COMPANY_ID, USER_ID, supabase as never, ACTOR,
    )) as Staged

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({ document_id: MAIL_DOC, resolved_from_inbox_item_id: MAIL_ITEM })
    expect((findCall('pending_operations', 'insert')![0] as Inserted).params).toMatchObject({
      document_id: MAIL_DOC, journal_entry_id: A1,
    })
  })

  it('still refuses an id that is neither a document nor an inbox item, naming the id sent', async () => {
    const { supabase } = setup()

    const err = await linkDocument
      .execute({ document_id: UNKNOWN, journal_entry_id: A1 }, COMPANY_ID, USER_ID, supabase as never, ACTOR)
      .then(() => null, (e: unknown) => e)

    expect(toToolError(err).error.code).toBe('NOT_FOUND')
    expect(toToolError(err).error.message_en).toContain(UNKNOWN)
  })
})

describe('gnubok_link_documents_to_vouchers with inbox item ids', () => {
  it('resolves the mail row, keeps the upload row and leaves the unknown id a miss', async () => {
    const { supabase, findCall } = setup()

    const result = (await linkDocuments.execute(
      {
        links: [
          { document_id: MAIL_ITEM, journal_entry_id: A1 },
          { document_id: UPLOAD_DOC, journal_entry_id: A2 },
          { document_id: UNKNOWN, journal_entry_id: A3 },
        ],
      },
      COMPANY_ID, USER_ID, supabase as never, ACTOR,
    )) as Staged

    const rows = result.preview.results as Array<Record<string, unknown>>
    expect(rows.map((r) => r.status)).toEqual(['matched', 'matched', 'document_not_found'])
    expect(rows[0]).toMatchObject({ document_id: MAIL_DOC, resolved_from_inbox_item_id: MAIL_ITEM })
    expect(rows[1]).not.toHaveProperty('resolved_from_inbox_item_id')
    expect(rows[2]).toMatchObject({ document_id: UNKNOWN })
    const links = (findCall('pending_operations', 'insert')![0] as Inserted).params.links as Array<Record<string, unknown>>
    expect(links.map((l) => [l.document_id, l.journal_entry_id])).toEqual([[MAIL_DOC, A1], [UPLOAD_DOC, A2]])
  })

  it('does not read the inbox when every id is a document', async () => {
    const { supabase, tables } = setup()

    await linkDocuments.execute(
      { links: [{ document_id: UPLOAD_DOC, journal_entry_id: A2 }] },
      COMPANY_ID, USER_ID, supabase as never, ACTOR,
    )

    expect(tables()).not.toContain('invoice_inbox_items')
  })

  it('treats a mail row and a row naming its document directly as the same document twice', async () => {
    const { supabase } = setup()

    const result = (await linkDocuments.execute(
      {
        links: [
          { document_id: MAIL_DOC, journal_entry_id: A1 },
          { document_id: MAIL_ITEM, journal_entry_id: A2 },
        ],
      },
      COMPANY_ID, USER_ID, supabase as never, ACTOR,
    )) as Staged

    expect((result.preview.results as Array<{ status: string }>).map((r) => r.status))
      .toEqual(['matched', 'duplicate_in_batch'])
  })
})
