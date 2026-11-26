/**
 * GET /api/arkiv/documents for a search or a page of many documents.
 *
 * The route reads the rows by id with `.in()` (the search hits, a folder
 * page), then their extractions, agreements, verifikat, types and expected
 * payments by the same ids, and supabase-js puts the ids in the GET query
 * string. A search of a picker (limit 100: up to 100 page hits and 100 file
 * names) or a page of up to 500 documents ran past the gateway's limit, and
 * the list answered 500. The fake gateway (tests/gateway-supabase.ts) refuses
 * a URL past a self-hosted Kong's 8 KB, the stricter of the two limits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf, type GatewayOptions } from '@/tests/gateway-supabase'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

type Row = Record<string, unknown>
type ListBody = { data: Array<{ document_id: string; doc_type: string | null; linked: { voucher: string | null; expected: number } }>; next_offset?: number | null }

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const doc = (n: number) => uuid(n, 'dddddddd')
const minute = (n: number) => new Date(Date.UTC(2026, 9, 1, 8, 0) + n * 60_000).toISOString()

const call = (qs: string) => GET(new Request(`http://localhost/api/arkiv/documents${qs}`), {} as never)

/** A document of the archive; `n` orders them, the highest newest. */
const attachment = (n: number, over: Row = {}): Row => ({
  id: doc(n), company_id: COMPANY, created_at: minute(n), file_name: `kvitto-${n}.pdf`, mime_type: 'application/pdf',
  file_size_bytes: 1000, doc_type: 'receipt', admission_state: 'admitted', journal_entry_id: null,
  journal_entry_line_id: null, extracted_data: null, page_count: 1, ...over,
})

function useGateway(tables: Record<string, Row[]>, options?: GatewayOptions) {
  const gateway = createGatewaySupabase(tables, options)
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: gateway.supabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue(COMPANY)
  return gateway
}

const docReads = (requests: ReturnType<typeof createGatewaySupabase>['requests']) =>
  requests.filter((r) => r.table === 'document_attachments' && inListOf(r, 'id').length > 0).map((r) => inListOf(r, 'id').length)

/** `pages` documents found by their text, then `names` more found by their file name. */
function searchArchive(pages: number, names: number) {
  const documents = [
    ...Array.from({ length: pages }, (_, i) => attachment(i + 1)),
    ...Array.from({ length: names }, (_, i) => attachment(pages + i + 1, { file_name: `faktura-${pages + i + 1}.pdf` })),
  ]
  const rpc = {
    search_document_pages: () =>
      Array.from({ length: pages }, (_, i) => ({ document_id: doc(i + 1), page_no: 1, file_name: `kvitto-${i + 1}.pdf`, headline: null, rank: 1 })),
  }
  return { documents, rpc }
}

const saved = { arkiv: process.env.ARKIV_COMPANY_IDS, brain: process.env.ARKIV_BRAIN_COMPANY_IDS }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ARKIV_COMPANY_IDS = COMPANY
  delete process.env.ARKIV_BRAIN_COMPANY_IDS
})

afterEach(() => {
  for (const [key, value] of [['ARKIV_COMPANY_IDS', saved.arkiv], ['ARKIV_BRAIN_COMPANY_IDS', saved.brain]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('GET /api/arkiv/documents: many documents', () => {
  it("answers a picker's search of 200 hits in requests the gateway takes, the newest 100 first", async () => {
    const { documents, rpc } = searchArchive(100, 100)
    const { requests, unmodelled } = useGateway({ document_attachments: documents }, { rpc })

    const { status, body } = await parseJsonResponse<ListBody>(await call('?q=faktura&limit=100'))

    expect(status).toBe(200)
    // The newest hundred are the file-name hits, read in the second slice.
    expect(body.data.map((r) => r.document_id)).toEqual(Array.from({ length: 100 }, (_, i) => doc(200 - i)))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(docReads(requests)).toEqual([100, 100])
    expect(unmodelled).toEqual([])
  })

  it('reads exactly one slice for 100 hits, and keeps the newest across slices at 101', async () => {
    const hundred = searchArchive(100, 0)
    const one = useGateway({ document_attachments: hundred.documents }, { rpc: hundred.rpc })
    const { body: first } = await parseJsonResponse<ListBody>(await call('?q=kvitto&limit=100'))
    expect(first.data).toHaveLength(100)
    expect(docReads(one.requests)).toEqual([100])

    const more = searchArchive(100, 1)
    const two = useGateway({ document_attachments: more.documents }, { rpc: more.rpc })
    const { body } = await parseJsonResponse<ListBody>(await call('?q=faktura&limit=100'))
    expect(docReads(two.requests)).toEqual([100, 1])
    // The 101st hit is the newest: it leads, and the oldest falls off the end.
    expect(body.data).toHaveLength(100)
    expect(body.data[0].document_id).toBe(doc(101))
    expect(body.data.map((r) => r.document_id)).not.toContain(doc(1))
  })

  it('answers a page of 500 booked documents with their types, verifikat and agreements', async () => {
    process.env.ARKIV_BRAIN_COMPANY_IDS = COMPANY
    const count = 500
    const entry = (n: number) => uuid(n, 'eeeeeeee')
    const { requests, unmodelled } = useGateway({
      document_attachments: Array.from({ length: count }, (_, i) => attachment(i + 1, { doc_type: null, journal_entry_id: entry(i + 1) })),
      document_classifications: Array.from({ length: count }, (_, i) => ({ document_id: doc(i + 1), doc_type: 'receipt', is_current: true })),
      journal_entries: Array.from({ length: count }, (_, i) => ({ id: entry(i + 1), voucher_series: 'A', voucher_number: i + 1, entry_date: '2026-10-01' })),
      agreements: [{ id: uuid(1, 'aaaaaaaa'), source_document_id: doc(1), title: 'Hyresavtal', counterparty_name: 'Fastighets AB', amount: '12000.00', currency: 'SEK', period: 'monthly' }],
      // A year of expected rent: more than one page of a slice would hold if the
      // obligations of a hundred agreements were read at once.
      agreement_obligations: Array.from({ length: 12 }, (_, i) => ({ id: uuid(i + 1, 'bbbbbbbb'), agreement_id: uuid(1, 'aaaaaaaa'), status: 'expected' })),
    })

    const { status, body } = await parseJsonResponse<ListBody>(await call(`?limit=${count}`))

    expect(status).toBe(200)
    expect(body.data).toHaveLength(count)
    expect(body.data.every((r) => r.doc_type === 'receipt')).toBe(true)
    expect(body.data.find((r) => r.document_id === doc(count))?.linked.voucher).toBe(`A${count}`)
    expect(body.data.find((r) => r.document_id === doc(1))?.linked.expected).toBe(12)
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(unmodelled).toEqual([])
  })

  it('answers a folder page of 200 in the order the database gave it', async () => {
    const documents = Array.from({ length: 201 }, (_, i) => attachment(i + 1))
    // The folder function orders oldest first here: the rows must keep it.
    const pageIds = documents.map((d) => d.id as string)
    const { requests, unmodelled } = useGateway(
      { document_attachments: documents },
      { rpc: { arkiv_document_page: () => pageIds.map((id) => ({ id })) } },
    )

    const { status, body } = await parseJsonResponse<ListBody>(await call('?folder=receipts&limit=200'))

    expect(status).toBe(200)
    expect(body.data.map((r) => r.document_id)).toEqual(pageIds.slice(0, 200))
    expect(body.next_offset).toBe(200)
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(unmodelled).toEqual([])
  })
})
