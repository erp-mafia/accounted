/**
 * gnubok_link_documents_to_vouchers, crm#1207: an agent attaching ~130
 * receipts to posted vouchers met three walls. A correction verifikat
 * ("Rättelse A2") resting on the original's invoice could not get the same
 * document, so the agent changed a byte to get a new one past the upload
 * dedupe; every link was its own approval; and the bulk tool only took
 * voucher numbers, where a broken fiscal year makes fiscal_year a guess.
 *
 *   - copy: true on a row whose document another verifikat holds (linked,
 *     proposed, or linked by another row of the same call) stages a copy row:
 *     approval archives a byte-identical copy for that verifikat. A free
 *     document is simply linked.
 *   - a row may name its verifikat by journal_entry_id.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { toToolError } from '../tool-result'

const linkDocuments = tools.find((t) => t.name === 'gnubok_link_documents_to_vouchers')!

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const ACTOR = { type: 'api_key' as const }

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const INVOICE = uuid(101)
const RECEIPT = uuid(102)
const A2 = uuid(202)
const A27 = uuid(227)
const ELSEWHERE = uuid(299)

type Period = {
  id: string; period_start: string; period_end: string
  is_closed: boolean; locked_at: string | null; closed_externally: boolean; closing_entry_id: string | null
}
// A broken fiscal year, as in the report: 2025-09-01..2026-08-31.
const FY: Period = {
  id: 'fp-2025', period_start: '2025-09-01', period_end: '2026-08-31',
  is_closed: false, locked_at: null, closed_externally: false, closing_entry_id: null,
}
const LOCKED_FY: Period = { ...FY, id: 'fp-2024', period_start: '2024-09-01', period_end: '2025-08-31', locked_at: '2026-01-10T00:00:00Z' }

function entry(id: string, n: number, fiscalPeriodId = FY.id) {
  return {
    id, entry_date: '2026-02-10', description: `Verifikat A${n}`, voucher_series: 'A', voucher_number: n,
    status: 'posted', fiscal_period_id: fiscalPeriodId,
  }
}
function doc(id: string, journalEntryId: string | null = null) {
  return { id, file_name: `${id.slice(-3)}.pdf`, mime_type: 'application/pdf', journal_entry_id: journalEntryId }
}

function setup(opts: {
  docs: ReturnType<typeof doc>[]
  /** journal_entries answers in query order: by voucher number, then by id. */
  entries: Array<ReturnType<typeof entry>[]>
  periods?: Period[]
  pending?: Array<{ id: string; operation_type?: string; params: Record<string, unknown> }>
}) {
  return createTableMockSupabase({
    fiscal_periods: { data: opts.periods ?? [FY] },
    document_attachments: { data: opts.docs },
    journal_entries: opts.entries.map((rows) => ({ data: rows })),
    pending_operations: [{ data: opts.pending ?? [] }, { data: { id: 'op-1' } }],
    transactions: { data: [] },
  })
}

const byNumber = (document_id: string, n: number, extra: Record<string, unknown> = {}) =>
  ({ document_id, voucher_series: 'A', voucher_number: n, fiscal_year: 2025, ...extra })

type Staged = { staged: boolean; preview: Record<string, unknown> }
type Inserted = {
  title: string
  params: { links: Array<{ document_id: string; journal_entry_id: string; copy?: boolean }> }
}

async function run(links: unknown[], supabase: unknown) {
  return (await linkDocuments.execute({ links }, COMPANY_ID, USER_ID, supabase as never, ACTOR)) as Staged
}
const statuses = (result: Staged) => (result.preview.results as Array<{ status: string }>).map((r) => r.status)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_link_documents_to_vouchers: copy rows (crm#1207)', () => {
  it('links the invoice to A2 and stages a copy of it for the correction A27, in one approval', async () => {
    const { supabase, findCall } = setup({ docs: [doc(INVOICE)], entries: [[entry(A2, 2), entry(A27, 27)]] })

    const result = await run([byNumber(INVOICE, 2), byNumber(INVOICE, 27, { copy: true })], supabase)

    expect(statuses(result)).toEqual(['matched', 'matched_copy'])
    const inserted = findCall('pending_operations', 'insert')![0] as Inserted
    expect(inserted.params.links).toEqual([
      { document_id: INVOICE, journal_entry_id: A2, journal_entry_line_id: null },
      { document_id: INVOICE, journal_entry_id: A27, journal_entry_line_id: null, copy: true },
    ])
    expect(inserted.title).toBe('Koppla 2 bilagor till verifikat A2-A27 (1 som kopia)')
    expect(result.preview).toMatchObject({ matched_count: 2, copy_count: 1, missed_count: 0 })
  })

  it('does not depend on row order: the copy row first still leaves the document itself to A2', async () => {
    const { supabase, findCall } = setup({ docs: [doc(INVOICE)], entries: [[entry(A2, 2), entry(A27, 27)]] })

    const result = await run([byNumber(INVOICE, 27, { copy: true }), byNumber(INVOICE, 2)], supabase)

    expect(statuses(result)).toEqual(['matched_copy', 'matched'])
    const links = (findCall('pending_operations', 'insert')![0] as Inserted).params.links
    expect(links.map((l) => [l.journal_entry_id, l.copy === true])).toEqual([[A27, true], [A2, false]])
  })

  it('copies a document a posted verifikat already holds; without copy the row stays already_linked', async () => {
    const { supabase, findCall } = setup({ docs: [doc(INVOICE, A2)], entries: [[entry(A27, 27)]] })

    const result = await run([byNumber(INVOICE, 27, { copy: true })], supabase)

    expect(statuses(result)).toEqual(['matched_copy'])
    expect((findCall('pending_operations', 'insert')![0] as Inserted).params.links[0]).toMatchObject({ copy: true })

    const plain = setup({ docs: [doc(INVOICE, A2)], entries: [[entry(A27, 27)]] })
    const err = await linkDocuments
      .execute({ links: [byNumber(INVOICE, 27)] }, COMPANY_ID, USER_ID, plain.supabase as never, ACTOR)
      .then(() => null, (e: unknown) => e)
    expect(toToolError(err).error.message_en).toMatch(/already_linked/)
  })

  it('copies a document another waiting proposal links elsewhere instead of refusing it as proposed_elsewhere', async () => {
    const { supabase } = setup({
      docs: [doc(INVOICE)],
      entries: [[entry(A27, 27)]],
      pending: [{ id: 'op-waiting', operation_type: 'link_document_to_voucher', params: { document_id: INVOICE, journal_entry_id: ELSEWHERE } }],
    })

    expect(statuses(await run([byNumber(INVOICE, 27, { copy: true })], supabase))).toEqual(['matched_copy'])
  })

  it('links a free document itself when copy is asked but nothing else holds it, and copies for the next verifikat', async () => {
    const { supabase, findCall } = setup({ docs: [doc(INVOICE)], entries: [[entry(A2, 2), entry(A27, 27)]] })

    const result = await run([byNumber(INVOICE, 2, { copy: true }), byNumber(INVOICE, 27, { copy: true })], supabase)

    expect(statuses(result)).toEqual(['matched', 'matched_copy'])
    const links = (findCall('pending_operations', 'insert')![0] as Inserted).params.links
    expect(links[0]).not.toHaveProperty('copy')
    expect(links[1]).toMatchObject({ copy: true })
  })

  it('never stages the same document twice for one verifikat, copy or not', async () => {
    const { supabase } = setup({ docs: [doc(INVOICE)], entries: [[entry(A2, 2)]] })

    const result = await run([byNumber(INVOICE, 2), byNumber(INVOICE, 2, { copy: true })], supabase)

    expect(statuses(result)).toEqual(['matched', 'duplicate_in_batch'])
  })

  it('a waiting copy row claims nothing: the same document can still be linked itself', async () => {
    const { supabase } = setup({
      docs: [doc(INVOICE)],
      entries: [[entry(A2, 2)]],
      pending: [{ id: 'op-copy', operation_type: 'link_documents_to_vouchers', params: { links: [{ document_id: INVOICE, journal_entry_id: A27, copy: true }] } }],
    })

    expect(statuses(await run([byNumber(INVOICE, 2)], supabase))).toEqual(['matched'])
  })
})

describe('gnubok_link_documents_to_vouchers: rows by journal_entry_id (crm#1207)', () => {
  it('resolves a row by verifikat id, naming the voucher in the preview, mixed with a row by number', async () => {
    const { supabase, findCall } = setup({
      docs: [doc(INVOICE), doc(RECEIPT)],
      entries: [[entry(A2, 2)], [entry(A27, 27)]],
    })

    const result = await run([byNumber(INVOICE, 2), { document_id: RECEIPT, journal_entry_id: A27 }], supabase)

    expect(statuses(result)).toEqual(['matched', 'matched'])
    expect((result.preview.results as unknown[])[1]).toMatchObject({
      document_id: RECEIPT, journal_entry_id: A27, voucher_label: 'A27', voucher_date: '2026-02-10',
    })
    expect((findCall('pending_operations', 'insert')![0] as Inserted).params.links.map((l) => l.journal_entry_id)).toEqual([A2, A27])
  })

  it('previews an unknown id as voucher_not_found and a verifikat in a locked year as period_locked', async () => {
    const { supabase } = setup({
      docs: [doc(INVOICE), doc(RECEIPT), doc(uuid(103))],
      periods: [FY, LOCKED_FY],
      entries: [[entry(A2, 2), entry(ELSEWHERE, 99, LOCKED_FY.id)]],
    })

    const result = await run([
      { document_id: INVOICE, journal_entry_id: A2 },
      { document_id: RECEIPT, journal_entry_id: uuid(404) },
      { document_id: uuid(103), journal_entry_id: ELSEWHERE },
    ], supabase)

    expect(statuses(result)).toEqual(['matched', 'voucher_not_found', 'period_locked'])
    expect(result.preview).toMatchObject({ period_locked_count: 1, locked_periods: [{ fiscal_period_id: LOCKED_FY.id, fiscal_year: 2024 }] })
  })

  it('refuses a row that names no verifikat at all', async () => {
    const { supabase } = setup({ docs: [doc(INVOICE)], entries: [[]] })

    const err = await linkDocuments
      .execute({ links: [{ document_id: INVOICE }] }, COMPANY_ID, USER_ID, supabase as never, ACTOR)
      .then(() => null, (e: unknown) => e)

    const { error } = toToolError(err)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toContain('journal_entry_id, or voucher_series/voucher_number/fiscal_year, is required')
  })
})
