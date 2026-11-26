/**
 * The Layer-1 reads of ingest (fetchStoredExternalIds, and the Open Payments
 * re-read's fetchStoredEnrichmentRows) for a large batch.
 *
 * Both send the batch's external_ids in an `.in()` list, which supabase-js
 * puts in the GET query string. They went out 500 at a time, about 25 KB of
 * URL for a bank feed's ids; the gateway refused such a request before
 * PostgREST saw it, and the stored-id read ignored the refusal, so the rows of
 * that slice were decided as if none of them were stored. The fake gateway
 * below builds the URL the way supabase-js does and refuses one past a
 * self-hosted Kong's 8 KB, the stricter of the two limits (hosted Supabase's
 * is about 16 KB).
 */
import { describe, expect, it } from 'vitest'
import { fetchStoredEnrichmentRows, fetchStoredExternalIds } from '../ingest'

type Row = Record<string, unknown>
type Answer = { data: Row[] | null; error: { message: string; code?: string } | null }

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const URL_LIMIT = 8 * 1024

interface Request {
  url: string
  inValues: number
}

function gatewaySupabase(rows: Row[], refuse?: (request: Request, index: number) => boolean) {
  const requests: Request[] = []
  const from = (table: string) => {
    const params = new URLSearchParams()
    const keep: Array<(row: Row) => boolean> = []
    let inValues = 0
    const builder = {
      select(columns: string) {
        params.append('select', columns)
        return builder
      },
      eq(column: string, value: unknown) {
        params.append(column, `eq.${String(value)}`)
        keep.push((row) => row[column] === value)
        return builder
      },
      in(column: string, values: readonly string[]) {
        // supabase-js quotes a value holding a comma or a parenthesis.
        const listed = values.map((v) => (/[,()]/.test(v) ? `"${v}"` : v))
        params.append(column, `in.(${listed.join(',')})`)
        inValues += values.length
        keep.push((row) => values.includes(row[column] as string))
        return builder
      },
      then(resolve: (answer: Answer) => void) {
        const request = { url: `https://abcdefghijklmnopqrst.supabase.co/rest/v1/${table}?${params}`, inValues }
        requests.push(request)
        if (request.url.length > URL_LIMIT) return resolve({ data: null, error: { message: 'Request-URI Too Large' } })
        if (refuse?.(request, requests.length - 1)) {
          return resolve({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } })
        }
        resolve({ data: structuredClone(rows.filter((row) => keep.every((test) => test(row)))), error: null })
      },
    }
    return builder
  }
  return { supabase: { from } as never, requests }
}

/** A bank feed's stable id, as the Enable Banking and Open Payments syncs build it. */
const feedId = (n: number) => `eb_SE4550000000058398257466_2026-11-${String(10 + (n % 20)).padStart(2, '0')}_${125000 + n}_0`
/** An id of a uuid's length, for the slice boundaries. */
const uuidLikeId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const stored = (externalIds: string[]): Row[] =>
  externalIds.map((externalId, i) => ({ id: `tx-${i}`, company_id: COMPANY, external_id: externalId }))

describe('fetchStoredExternalIds', () => {
  it('finds every stored id of a 600-row bank feed batch, in requests the gateway takes', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => feedId(i))
    const { supabase, requests } = gatewaySupabase(stored(ids))

    const found = await fetchStoredExternalIds(supabase, COMPANY, ids)

    expect(found.size).toBe(600)
    expect(found.get(ids[0])).toBe('tx-0')
    expect(found.get(ids[599])).toBe('tx-599')
    expect(requests.every((r) => r.url.length <= URL_LIMIT)).toBe(true)
    expect(requests.reduce((sum, r) => sum + r.inValues, 0)).toBe(600)
  })

  it('sends nothing for an empty batch', async () => {
    const { supabase, requests } = gatewaySupabase([])

    expect((await fetchStoredExternalIds(supabase, COMPANY, [])).size).toBe(0)
    expect(requests).toEqual([])
  })

  it('reads ids no longer than a uuid 100 to a request: exactly one slice, then one over', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => uuidLikeId(i))
    const one = gatewaySupabase(stored(hundred))
    expect((await fetchStoredExternalIds(one.supabase, COMPANY, hundred)).size).toBe(100)
    expect(one.requests.map((r) => r.inValues)).toEqual([100])

    const hundredAndOne = [...hundred, uuidLikeId(100)]
    const two = gatewaySupabase(stored(hundredAndOne))
    expect((await fetchStoredExternalIds(two.supabase, COMPANY, hundredAndOne)).size).toBe(101)
    expect(two.requests.map((r) => r.inValues)).toEqual([100, 1])
  })

  it('puts fewer of the longest ids the v1 API takes in a request, so each stays inside the limit', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `byra-feed:${String(i).padStart(4, '0')}:${'x'.repeat(185)}`)
    expect(ids.every((id) => id.length === 200)).toBe(true)
    const { supabase, requests } = gatewaySupabase(stored(ids))

    const found = await fetchStoredExternalIds(supabase, COMPANY, ids)

    expect(found.size).toBe(120)
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.every((r) => r.url.length <= URL_LIMIT)).toBe(true)
  })

  it('throws when one slice cannot be read, so no row of the batch is decided on a partial answer', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => uuidLikeId(i))
    const { supabase, requests } = gatewaySupabase(stored(ids), (_request, index) => index === 1)

    await expect(fetchStoredExternalIds(supabase, COMPANY, ids)).rejects.toMatchObject({ code: '57014' })
    expect(requests).toHaveLength(2)
  })
})

describe('fetchStoredEnrichmentRows', () => {
  it('reads the stored rows of a large re-read in requests the gateway takes', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => feedId(i))
    const { supabase, requests } = gatewaySupabase(stored(ids))

    const rows = await fetchStoredEnrichmentRows(supabase, COMPANY, ids)

    expect(rows.size).toBe(300)
    expect(rows.get(ids[299])).toMatchObject({ id: 'tx-299' })
    expect(requests.every((r) => r.url.length <= URL_LIMIT)).toBe(true)
  })

  it('throws when a slice cannot be read; ingest then leaves the re-read rows as stored', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => uuidLikeId(i))
    const { supabase } = gatewaySupabase(stored(ids), (_request, index) => index === 1)

    await expect(fetchStoredEnrichmentRows(supabase, COMPANY, ids)).rejects.toMatchObject({ code: '57014' })
  })
})
