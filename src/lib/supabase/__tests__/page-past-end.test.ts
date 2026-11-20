import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pastEndTotal, withEmptyPagePastEnd } from '../page-past-end'
import { createServiceRoleClient } from '../service-client'

// supabase-js resolves a WebSocket when it builds its realtime client; Node 20
// (CI) has none. Nothing here subscribes, so an inert one is enough.
beforeEach(() => {
  if (!('WebSocket' in globalThis)) vi.stubGlobal('WebSocket', class {})
})

const REST = 'https://project.supabase.co/rest/v1/open_bank_rows?select=id&offset=40&limit=20'

/** PostgREST's refusal of a counted read whose offset lies past the last row. */
function outOfBounds(offset: number, total: number): Response {
  return new Response(
    JSON.stringify({
      code: 'PGRST103',
      details: `An offset of ${offset} was requested, but there are only ${total} rows.`,
      hint: null,
      message: 'Requested range not satisfiable',
    }),
    { status: 416, headers: { 'content-type': 'application/json; charset=utf-8', 'content-range': `*/${total}` } },
  )
}

function rangeRefusal(details: string): Response {
  return new Response(
    JSON.stringify({ code: 'PGRST103', details, hint: null, message: 'Requested range not satisfiable' }),
    { status: 416, headers: { 'content-type': 'application/json' } },
  )
}

describe('withEmptyPagePastEnd', () => {
  it('answers an offset past the last row as 200 [] with the total as Content-Range', async () => {
    const send = withEmptyPagePastEnd(vi.fn(async () => outOfBounds(40, 25)))

    const response = await send(REST)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
    expect(response.headers.get('content-range')).toBe('*/25')
  })

  it.each([
    ['a negative limit', 'Limit should be greater than or equal to zero.'],
    ['a reversed range', 'The lower boundary must be lower than or equal to the upper boundary in the Range header.'],
  ])('passes %s through: that refusal is a caller bug, not an empty page', async (_label, details) => {
    const refusal = rangeRefusal(details)
    const send = withEmptyPagePastEnd(vi.fn(async () => refusal))

    const response = await send(REST)

    expect(response).toBe(refusal)
    expect(response.status).toBe(416)
  })

  it('passes every other response through untouched', async () => {
    const ok = new Response('[{"id":"a"}]', { status: 200 })
    const storage416 = new Response('{"statusCode":"416","error":"InvalidRange"}', { status: 416 })
    const base = vi.fn<typeof fetch>()
    base.mockResolvedValueOnce(ok).mockResolvedValueOnce(storage416).mockResolvedValueOnce(outOfBounds(40, 25))
    const send = withEmptyPagePastEnd(base)

    expect(await send(REST)).toBe(ok)
    expect(await send('https://project.supabase.co/storage/v1/object/documents/a.pdf')).toBe(storage416)
    // A 416 shaped like PostgREST's but not to a PostgREST URL stays as it is.
    expect((await send('https://project.supabase.co/storage/v1/object/x')).status).toBe(416)
  })

  it('sends with the given fetch, the request unchanged', async () => {
    const base = vi.fn(async () => new Response('[]', { status: 200 }))
    const init = { method: 'GET', headers: { Prefer: 'count=exact' } }

    await withEmptyPagePastEnd(base)(REST, init)

    expect(base).toHaveBeenCalledWith(REST, init)
  })
})

describe('pastEndTotal', () => {
  it('reads the total from the refusal and leaves the body readable', async () => {
    const response = outOfBounds(100, 0)
    expect(await pastEndTotal(response)).toBe(0)
    expect((await response.json()).code).toBe('PGRST103')
  })

  it('is null for a body that is not JSON', async () => {
    expect(await pastEndTotal(new Response('Range Not Satisfiable', { status: 416 }))).toBeNull()
  })
})

describe('a server client paging past the last row', () => {
  it('reads data [] and the total instead of a "Requested range not satisfiable" error', async () => {
    const fetchMock = vi.fn(async () => outOfBounds(40, 25))
    const supabase = createServiceRoleClient('https://project.supabase.co', 'service-role-key', {
      global: { fetch: fetchMock },
    })

    const result = await supabase
      .from('open_bank_rows')
      .select('id', { count: 'exact' })
      .eq('company_id', 'company-1')
      .range(40, 59)

    expect(result.error).toBeNull()
    expect(result.data).toEqual([])
    expect(result.count).toBe(25)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still reports a reversed range as the error it is', async () => {
    const supabase = createServiceRoleClient('https://project.supabase.co', 'service-role-key', {
      global: { fetch: vi.fn(async () => rangeRefusal('Limit should be greater than or equal to zero.')) },
    })

    const result = await supabase.from('open_bank_rows').select('id', { count: 'exact' }).range(40, 59)

    expect(result.error).toMatchObject({ code: 'PGRST103' })
    expect(result.data).toBeNull()
  })
})
