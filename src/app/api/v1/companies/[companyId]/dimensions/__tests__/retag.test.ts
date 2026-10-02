/**
 * POST /api/v1/companies/:companyId/dimensions/retag: the v1 door to the
 * retag of posted lines (operation dimensions.retag-lines over
 * lib/dimensions/retag-service.ts). Before it, retagging was dashboard and
 * MCP only. merge is the default: the pairs are set and each line keeps its
 * other dimensions; replace is explicit.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as retag } from '../retag/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

/** Per-table queue mock (the last entry repeats) that records every call; rpc calls too. */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const next = (key: string) => {
    const q = queues.get(key)
    return q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
  }
  const buildChain = (key: string, result?: TableResp): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result ?? next(key))
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key, result)
          }
        },
      },
    )
  const rpc = vi.fn((fn: string, args: unknown) => {
    calls.push({ table: 'rpc', method: fn, args: [args] })
    return buildChain('rpc', next('rpc'))
  })
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LINE_1 = '11111111-1111-4111-8111-111111111111'
const LINE_2 = '22222222-2222-4222-8222-222222222222'
const LINE_FOREIGN = '33333333-3333-4333-8333-333333333333'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const URL_ = `https://x.test/api/v1/companies/${COMPANY_ID}/dimensions/retag`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function post(body: Record<string, unknown>, query = ''): Request {
  return new Request(`${URL_}${query}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

const REASON = 'Projektet saknades på fakturan'
/** The lines' current bags, and the company's entries among their parents. */
const LINES = {
  journal_entry_lines: {
    data: [
      { id: LINE_1, journal_entry_id: 'entry-1', dimensions: { '1': 'KS01' } },
      { id: LINE_2, journal_entry_id: 'entry-1', dimensions: {} },
      { id: LINE_FOREIGN, journal_entry_id: 'entry-foreign', dimensions: { '1': 'X' } },
    ],
    error: null,
  },
  journal_entries: { data: [{ id: 'entry-1' }], error: null },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read', 'bookkeeping:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/dimensions/retag', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await retag(post({ line_ids: [LINE_1], dimensions: { '6': 'P001' }, reason: REASON }), params)
    expect(res.status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await retag(post({ line_ids: [LINE_1], dimensions: { '6': 'P001' }, reason: REASON }), params)
    expect(res.status).toBe(403)
  })

  it('404 NOT_FOUND for a company the key cannot reach', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: { data: null, error: null } }))
    const res = await retag(post({ line_ids: [LINE_1], dimensions: { '6': 'P001' }, reason: REASON }), params)
    expect(res.status).toBe(404)
  })

  it('400 VALIDATION_ERROR for an empty bag, an unknown mode or a short reason, nothing read', async () => {
    for (const body of [
      { line_ids: [LINE_1], dimensions: {}, reason: REASON },
      { line_ids: [LINE_1], dimensions: { '6': 'P001' }, mode: 'append', reason: REASON },
      { line_ids: [LINE_1], dimensions: { '6': 'P001' }, reason: 'x' },
      { line_ids: ['not-a-uuid'], dimensions: { '6': 'P001' }, reason: REASON },
    ]) {
      const client = makeClient({ company_members: MEMBER })
      mockServiceClient.mockReturnValue(client)
      const res = await retag(post(body), params)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
      expect(client.calls.some((c) => c.table === 'journal_entry_lines' || c.table === 'rpc')).toBe(false)
    }
  })

  it('merges by default: each line keeps its other dimensions, and a line of another company is refused unread', async () => {
    const client = makeClient({
      company_members: MEMBER,
      ...LINES,
      rpc: [{ data: { changed: true }, error: null }, { data: { changed: true }, error: null }],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await retag(
      post({ line_ids: [LINE_1, LINE_2, LINE_FOREIGN], dimensions: { '6': 'P001' }, reason: REASON }),
      params,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      retagged: 2,
      unchanged: 0,
      failed_count: 1,
      failed: [{ line_id: LINE_FOREIGN, error: 'Verifikationsraden hittades inte.' }],
      mode: 'merge',
    })
    const rpcCalls = client.calls.filter((c) => c.table === 'rpc')
    expect(rpcCalls.map((c) => c.method)).toEqual(['retag_line_dimensions', 'retag_line_dimensions'])
    expect(rpcCalls[0].args[0]).toEqual({
      p_company_id: COMPANY_ID,
      p_line_id: LINE_1,
      p_dimensions: { '1': 'KS01', '6': 'P001' },
      p_reason: REASON,
      p_user_id: 'user-1',
    })
    expect(rpcCalls[1].args[0]).toMatchObject({ p_line_id: LINE_2, p_dimensions: { '6': 'P001' } })
  })

  it('replace sends exactly the given bag and reads no line first', async () => {
    const client = makeClient({ company_members: MEMBER, rpc: { data: { changed: true }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await retag(
      post({ line_ids: [LINE_1], dimensions: { '6': 'P001' }, mode: 'replace', reason: REASON }),
      params,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ retagged: 1, mode: 'replace' })
    expect(client.calls.some((c) => c.table === 'journal_entry_lines')).toBe(false)
    expect(client.calls.find((c) => c.table === 'rpc')?.args[0]).toMatchObject({ p_dimensions: { '6': 'P001' } })
  })

  it('400 DIMENSION_RETAG_FAILED with every refusal when no line could be retagged', async () => {
    const client = makeClient({
      company_members: MEMBER,
      rpc: { data: null, error: { code: 'P0001', message: 'Perioden är låst: använd rättelseverifikat (storno) för att ändra dimensioner.' } },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await retag(
      post({ line_ids: [LINE_1, LINE_2], dimensions: { '6': 'P001' }, mode: 'replace', reason: REASON }),
      params,
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('DIMENSION_RETAG_FAILED')
    expect(body.error.details.failed_count).toBe(2)
    expect(body.error.details.failed[0]).toEqual({
      line_id: LINE_1,
      error: 'Perioden är låst: använd rättelseverifikat (storno) för att ändra dimensioner.',
    })
  })

  it('a dry run shows each line before and after and retags nothing', async () => {
    const client = makeClient({ company_members: MEMBER, ...LINES })
    mockServiceClient.mockReturnValue(client)
    const res = await retag(
      post({ line_ids: [LINE_1, LINE_FOREIGN], dimensions: { '6': 'P001' }, reason: REASON }, '?dry_run=true'),
      params,
    )
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.dry_run).toBe(true)
    expect(data.preview).toEqual({
      mode: 'merge',
      lines: [{ line_id: LINE_1, dimensions_before: { '1': 'KS01' }, dimensions_after: { '1': 'KS01', '6': 'P001' } }],
      missing_line_ids: [LINE_FOREIGN],
      unchanged_lines: 0,
    })
    expect(client.rpc).not.toHaveBeenCalled()
  })
})
