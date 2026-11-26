/**
 * gnubok_link_documents_to_vouchers with a full call of 300 links.
 *
 * The tool read the call's documents, the inbox items named in their place
 * and the verifikat named by id with one `.in()` each, and supabase-js puts
 * the ids in the GET query string: 300 uuids are about 11.7 KB, past a
 * self-hosted Kong's 8 KB, so the read was refused and the whole call failed.
 * The fake gateway (tests/gateway-supabase.ts) refuses a URL past that limit.
 */
import { describe, expect, it } from 'vitest'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'
import { tools } from '../server'

const linkDocuments = tools.find((t) => t.name === 'gnubok_link_documents_to_vouchers')!

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const USER = '5b0c3c1e-0000-4000-8000-000000000002'
const ACTOR = { type: 'api_key' as const }
const CALL = 300

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)
const documentId = (n: number) => uuid(n, 'dddddddd')
const inboxItemId = (n: number) => uuid(n, 'cccccccc')
const entryId = (n: number) => uuid(n, 'eeeeeeee')

const PERIOD = {
  id: uuid(1, 'ffffffff'), company_id: COMPANY, period_start: '2026-01-01', period_end: '2026-12-31',
  is_closed: false, locked_at: null, closed_externally: false, closing_entry_id: null,
}
const doc = (n: number) => ({
  id: documentId(n), company_id: COMPANY, file_name: `kvitto-${n}.pdf`, mime_type: 'application/pdf', journal_entry_id: null,
})
const entry = (n: number) => ({
  id: entryId(n), company_id: COMPANY, entry_date: '2026-03-02', description: `Verifikat A${n}`,
  voucher_series: 'A', voucher_number: n, status: 'posted', fiscal_period_id: PERIOD.id,
})

type Staged = { staged: boolean; preview: { results: Array<Record<string, unknown>> } }
type Inserted = { params: { links: Array<{ document_id: string; journal_entry_id: string; copy?: boolean }> } }

async function run(links: unknown[], tables: Record<string, readonly Record<string, unknown>[]>) {
  const gateway = createGatewaySupabase({ fiscal_periods: [PERIOD], pending_operations: [], transactions: [], ...tables })
  const result = (await linkDocuments.execute({ links }, COMPANY, USER, gateway.supabase as never, ACTOR)) as Staged
  const insert = gateway.requestsTo('pending_operations').find((r) => r.method === 'POST')
  return { ...gateway, result, inserted: insert?.body as Inserted | undefined }
}

describe('gnubok_link_documents_to_vouchers: a full call of 300 links', () => {
  it('reads 300 documents named by voucher number, in requests the gateway takes', async () => {
    const { result, inserted, requests, requestsTo, unmodelled } = await run(
      range(CALL).map((n) => ({ document_id: documentId(n), voucher_series: 'A', voucher_number: n, fiscal_year: 2026 })),
      { document_attachments: range(CALL).map(doc), journal_entries: range(CALL).map(entry) },
    )

    expect(result.staged).toBe(true)
    expect(result.preview.results.filter((r) => r.status === 'matched')).toHaveLength(CALL)
    expect(inserted?.params.links.map((l) => [l.document_id, l.journal_entry_id]))
      .toEqual(range(CALL).map((n) => [documentId(n), entryId(n)]))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('document_attachments').map((r) => inListOf(r, 'id').length)).toEqual([100, 100, 100])
    expect(unmodelled).toEqual([])
  })

  it('resolves 300 inbox item ids to the documents they hold, in requests the gateway takes', async () => {
    const { result, inserted, requests, requestsTo, unmodelled } = await run(
      range(CALL).map((n) => ({ document_id: inboxItemId(n), voucher_series: 'A', voucher_number: n, fiscal_year: 2026 })),
      {
        // Mail arrivals: each document has an id of its own.
        invoice_inbox_items: range(CALL).map((n) => ({ id: inboxItemId(n), company_id: COMPANY, document_id: documentId(n) })),
        document_attachments: range(CALL).map(doc),
        journal_entries: range(CALL).map(entry),
      },
    )

    expect(result.preview.results.filter((r) => r.status === 'matched')).toHaveLength(CALL)
    expect(result.preview.results[CALL - 1]).toMatchObject({
      document_id: documentId(CALL), resolved_from_inbox_item_id: inboxItemId(CALL),
    })
    expect(inserted?.params.links.map((l) => [l.document_id, l.journal_entry_id]))
      .toEqual(range(CALL).map((n) => [documentId(n), entryId(n)]))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('invoice_inbox_items').map((r) => inListOf(r, 'id').length)).toEqual([100, 100, 100])
    // The inbox item ids first, then the documents they hold.
    expect(requestsTo('document_attachments').map((r) => inListOf(r, 'id').length)).toEqual([100, 100, 100, 100, 100, 100])
    expect(unmodelled).toEqual([])
  })

  it('reads 300 verifikat named by id, a bank statement copied to each, in requests the gateway takes', async () => {
    const { result, inserted, requests, requestsTo, unmodelled } = await run(
      range(CALL).map((n) => ({ document_id: documentId(1), journal_entry_id: entryId(n), copy: true })),
      { document_attachments: [doc(1)], journal_entries: range(CALL).map(entry) },
    )

    // The first row takes the free document; every other verifikat gets a copy.
    expect(result.preview.results.map((r) => r.status))
      .toEqual(['matched', ...Array<string>(CALL - 1).fill('matched_copy')])
    expect(inserted?.params.links.map((l) => l.journal_entry_id)).toEqual(range(CALL).map(entryId))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('journal_entries').map((r) => inListOf(r, 'id').length)).toEqual([100, 100, 100])
    expect(unmodelled).toEqual([])
  })
})
