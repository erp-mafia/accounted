/**
 * evidenceLines for the most records of one kind the question page names.
 *
 * The page lists up to SETTLED_SHOWN_MAX questions closed as settled, each
 * with up to QUESTION_LIMITS.maxEvidence records of its own and as many named
 * by its close: 320 references, all of one kind at most. They were read by id
 * with one `.in()` per kind, and supabase-js puts the ids in the GET query
 * string: 320 uuids are about 12.5 KB, past a self-hosted Kong's 8 KB, so the
 * read was refused and the page failed. The fake gateway
 * (tests/gateway-supabase.ts) refuses a URL past that limit.
 */
import { describe, expect, it } from 'vitest'
import { chunk } from '@/lib/utils'
import { SETTLED_SHOWN_MAX } from '../app-answer'
import { evidenceLines, type EvidenceLine } from '../evidence-lines'
import { QUESTION_LIMITS, type EvidenceKind } from '../types'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
/** A settled question's own records and its close's, for every settled question the page lists. */
const LISTS = SETTLED_SHOWN_MAX * 2
const REFERENCES = LISTS * QUESTION_LIMITS.maxEvidence
/** Lines of each verifikat: a slice of 100 has more than one page of them. */
const LINES_PER_ENTRY = 12

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)

type Row = Record<string, unknown>

interface KindCase {
  kind: Exclude<EvidenceKind, 'account'>
  table: string
  record: (n: number, id: string) => Row
  /** What the line of the n-th record reads. */
  line: (n: number) => Partial<EvidenceLine>
}

const CASES: KindCase[] = [
  {
    kind: 'transaction',
    table: 'transactions',
    record: (n, id) => ({ id, company_id: COMPANY, date: '2026-11-03', description: `Rad ${n}`, merchant_name: null, amount: -n, currency: 'SEK' }),
    line: (n) => ({ label: `Rad ${n}`, amount: -n }),
  },
  {
    kind: 'journal_entry',
    table: 'journal_entries',
    record: (n, id) => ({ id, company_id: COMPANY, voucher_series: 'A', voucher_number: n, entry_date: '2026-04-27', description: `Avgift ${n}` }),
    // Half of the lines debit 100 each: the total counts every one of them.
    line: (n) => ({ label: `A${n}`, amount: (LINES_PER_ENTRY / 2) * 100 }),
  },
  {
    kind: 'invoice',
    table: 'invoices',
    record: (n, id) => ({ id, company_id: COMPANY, invoice_number: `F-${n}`, invoice_date: '2026-10-01', total: n, currency: 'SEK', customer: { name: 'Kunden AB' } }),
    line: (n) => ({ label: 'Kunden AB', detail: `F-${n}`, amount: n }),
  },
  {
    kind: 'supplier_invoice',
    table: 'supplier_invoices',
    record: (n, id) => ({ id, company_id: COMPANY, supplier_invoice_number: `LF-${n}`, invoice_date: '2026-10-05', total: n, currency: 'SEK', supplier: { name: 'Säljaren AB' } }),
    line: (n) => ({ label: 'Säljaren AB', detail: `LF-${n}`, amount: n }),
  },
  {
    kind: 'document',
    table: 'document_attachments',
    record: (n, id) => ({ id, company_id: COMPANY, file_name: `kvitto-${n}.pdf`, created_at: '2026-09-22T07:12:00.000Z' }),
    line: (n) => ({ label: `kvitto-${n}.pdf` }),
  },
  {
    kind: 'fact',
    table: 'agent_memory',
    record: (n, id) => ({ id, company_id: COMPANY, content: `Fakta ${n}`, created_at: '2026-08-05T10:00:00.000Z' }),
    line: (n) => ({ label: `Fakta ${n}` }),
  },
]

describe('evidenceLines: every record a page of settled questions names', () => {
  it.each(CASES)(`reads ${REFERENCES} $kind records in requests the gateway takes`, async ({ kind, table, record, line }) => {
    const ids = range(REFERENCES).map((n) => uuid(n, '7e7e7e7e'))
    const tables: Record<string, Row[]> = { [table]: ids.map((id, i) => record(i + 1, id)) }
    if (kind === 'journal_entry') {
      tables.journal_entry_lines = ids.flatMap((id, i) =>
        range(LINES_PER_ENTRY).map((l) => ({
          id: uuid(i * LINES_PER_ENTRY + l, 'dddddddd'),
          journal_entry_id: id,
          debit_amount: l <= LINES_PER_ENTRY / 2 ? 100 : 0,
        })),
      )
    }
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(tables)
    const lists = chunk(ids, QUESTION_LIMITS.maxEvidence).map((list) => list.map((id) => ({ kind, id })))

    const lines = await evidenceLines(supabase, COMPANY, lists)

    expect(lines).toHaveLength(LISTS)
    expect(lines.flat()).toEqual(ids.map((id, i) => expect.objectContaining({ kind, id, found: true, ...line(i + 1) })))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo(table).map((r) => inListOf(r, 'id').length)).toEqual([100, 100, 100, 20])
    expect(unmodelled).toEqual([])
  })
})
