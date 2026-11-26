/**
 * originalsOf for a full page of list_records.
 *
 * A page lists up to LIST_LIMIT_MAX (200) documents, and the earliest copy of
 * each is found by its text hash and its file hash with `.in()`. supabase-js
 * puts the values in the GET query string, and a sha256 in hex costs about 67
 * characters there: 200 of them are about 13.5 KB, past a self-hosted Kong's
 * 8 KB, so the read was refused and the page failed. The fake gateway
 * (tests/gateway-supabase.ts) refuses a URL past that limit.
 */
import { describe, expect, it } from 'vitest'
import { LIST_LIMIT_MAX, originalsOf } from '../list-records'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf, type GatewayRequest } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
/** A sha256 in hex: 64 characters. */
const sha = (n: number, kind: string) => `${kind.repeat(28)}${String(n).padStart(8, '0')}`
const at = (year: number, month: number, n: number) => new Date(Date.UTC(year, month, 1) + n * 1000).toISOString()

/**
 * `count` documents on the page, uploaded in September. Each has two copies
 * of its text, uploaded in March and in April, and a copy of its file,
 * uploaded in January for an even number (the earliest copy) and in May for
 * an odd one (later than the first text copy).
 */
function archive(count: number) {
  const page = []
  const attachments = []
  const classifications = []
  for (let n = 1; n <= count; n++) {
    const doc = { id: uuid(n, 'd0000000'), company_id: COMPANY, created_at: at(2026, 8, n), sha256_hash: sha(n, 'b2') }
    const textCopy = { id: uuid(n, 'd1000000'), company_id: COMPANY, created_at: at(2026, 2, n), sha256_hash: sha(n, 'c3') }
    const laterTextCopy = { id: uuid(n, 'd3000000'), company_id: COMPANY, created_at: at(2026, 3, n), sha256_hash: sha(n, 'c4') }
    const fileCopy = { id: uuid(n, 'd2000000'), company_id: COMPANY, created_at: n % 2 === 0 ? at(2026, 0, n) : at(2026, 4, n), sha256_hash: sha(n, 'b2') }
    page.push({ id: doc.id, created_at: doc.created_at, sha256_hash: doc.sha256_hash })
    attachments.push(doc, textCopy, laterTextCopy, fileCopy)
    classifications.push(
      { id: uuid(n, 'f0000000'), company_id: COMPANY, document_id: doc.id, content_sha256: sha(n, 'a1'), is_current: true },
      { id: uuid(n, 'f1000000'), company_id: COMPANY, document_id: textCopy.id, content_sha256: sha(n, 'a1'), is_current: true },
      { id: uuid(n, 'f3000000'), company_id: COMPANY, document_id: laterTextCopy.id, content_sha256: sha(n, 'a1'), is_current: true },
    )
  }
  return { page, tables: { document_attachments: attachments, document_classifications: classifications } }
}

/** The original of each document on the page: the text copy for an odd number, the file copy for an even one. */
const expectedOriginals = (count: number) =>
  new Map(Array.from({ length: count }, (_, i) => [uuid(i + 1, 'd0000000'), uuid(i + 1, (i + 1) % 2 === 0 ? 'd2000000' : 'd1000000')]))

const textSlices = (requests: GatewayRequest[]) => requests.filter((r) => r.table === 'document_classifications').map((r) => inListOf(r, 'content_sha256').length).filter((n) => n > 0)
const fileSlices = (requests: GatewayRequest[]) => requests.filter((r) => r.table === 'document_attachments').map((r) => inListOf(r, 'sha256_hash').length).filter((n) => n > 0)

describe('originalsOf: a full page of documents', () => {
  it('finds the earliest copy of every document by text and by file, in requests the gateway takes', async () => {
    const { page, tables } = archive(LIST_LIMIT_MAX)
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(tables)

    expect(await originalsOf(supabase, COMPANY, page)).toEqual(expectedOriginals(LIST_LIMIT_MAX))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(textSlices(requests)).toEqual([100, 100])
    expect(fileSlices(requests)).toEqual([100, 100])
    // The page and its text copies, 600 documents, read by id 100 at a time.
    expect(requestsTo('document_attachments').map((r) => inListOf(r, 'id').length).filter((n) => n > 0)).toEqual(Array(6).fill(100))
    expect(unmodelled).toEqual([])
  })

  it('finds the earliest copy of a text archived more times over than one page of rows holds', async () => {
    const doc = { id: uuid(1, 'd0000000'), company_id: COMPANY, created_at: at(2026, 8, 0), sha256_hash: sha(1, 'b2') }
    const copies = Array.from({ length: 1200 }, (_, i) => ({ id: uuid(i + 1, 'd1000000'), company_id: COMPANY, created_at: at(2026, 2, i + 1), sha256_hash: sha(i + 1, 'c3') }))
    // The earliest copy is read last: its classification sorts after every other one.
    const earliest = { id: uuid(9999, 'd1000000'), company_id: COMPANY, created_at: at(2026, 0, 0), sha256_hash: sha(9999, 'c3') }
    const classifications = [doc, ...copies, earliest].map((d, i) => ({ id: d === earliest ? uuid(99999, 'f0000000') : uuid(i + 1, 'f0000000'), company_id: COMPANY, document_id: d.id, content_sha256: sha(1, 'a1'), is_current: true }))
    const { supabase, requests, unmodelled } = createGatewaySupabase({ document_attachments: [doc, ...copies, earliest], document_classifications: classifications })

    expect(await originalsOf(supabase, COMPANY, [{ id: doc.id, created_at: doc.created_at, sha256_hash: doc.sha256_hash }])).toEqual(new Map([[doc.id, earliest.id]]))
    // One slice of one text, in two pages.
    expect(textSlices(requests)).toEqual([1, 1])
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(unmodelled).toEqual([])
  })
})

describe('originalsOf: the slice boundary', () => {
  it.each([
    [100, [100]],
    [101, [100, 1]],
  ])('reads %i texts and files in slices of %j and finds every original', async (count, slices) => {
    const { page, tables } = archive(count)
    const { supabase, requests, unmodelled } = createGatewaySupabase(tables)

    expect(await originalsOf(supabase, COMPANY, page)).toEqual(expectedOriginals(count))
    expect(textSlices(requests)).toEqual(slices)
    expect(fileSlices(requests)).toEqual(slices)
    expect(unmodelled).toEqual([])
  })

  it.each([
    ['texts', (r: GatewayRequest) => r.table === 'document_classifications' && inListOf(r, 'content_sha256').length === 1],
    ['files', (r: GatewayRequest) => r.table === 'document_attachments' && inListOf(r, 'sha256_hash').length === 1],
  ])('fails when the last slice of the %s cannot be read', async (_, refuse) => {
    const { page, tables } = archive(101)
    const { supabase } = createGatewaySupabase(tables, { refuse })

    await expect(originalsOf(supabase, COMPANY, page)).rejects.toThrow('duplicates failed: canceling statement due to statement timeout')
  })
})
