/**
 * POST /api/v1/companies/:companyId/dimensions/retag: the v1 door to the
 * retag of posted lines (operation dimensions.retag-lines over
 * lib/dimensions/retag-service.ts). Before it, retagging was dashboard and
 * MCP only. merge is the default: the pairs are set and each line keeps its
 * other dimensions; replace is explicit. A line behind a period lock is left
 * untagged and the answer says so: outcome partial, counted per reason, and
 * the dry run names it before anything is written (crm#1908).
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
import { routeRpcCalls, isIdempotencyClaim } from '@/tests/helpers'

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
const OPEN_ENTRY = { id: 'entry-1', entry_date: '2026-03-01', fiscal_period_id: 'period-open' }
const CLOSED_ENTRY = { id: 'entry-0', entry_date: '2025-12-20', fiscal_period_id: 'period-closed' }
/** The lock state the retag reads: no company lock date, one open and one closed period. */
const LOCKS = {
  company_settings: { data: { bookkeeping_locked_through: null }, error: null },
  fiscal_periods: {
    data: [
      { id: 'period-open', is_closed: false, locked_at: null },
      { id: 'period-closed', is_closed: true, locked_at: '2026-02-01T00:00:00Z' },
    ],
    error: null,
  },
}
/** The lines' current bags, the company's entries among their parents, and the locks. */
const LINES = {
  journal_entry_lines: {
    data: [
      { id: LINE_1, journal_entry_id: 'entry-1', dimensions: { '1': 'KS01' } },
      { id: LINE_2, journal_entry_id: 'entry-1', dimensions: {} },
      { id: LINE_FOREIGN, journal_entry_id: 'entry-foreign', dimensions: { '1': 'X' } },
    ],
    error: null,
  },
  journal_entries: { data: [OPEN_ENTRY], error: null },
  ...LOCKS,
}
/** LINE_1 in the closed year, LINE_2 in the open one. */
const LINES_ACROSS_YEAR_END = {
  journal_entry_lines: {
    data: [
      { id: LINE_1, journal_entry_id: CLOSED_ENTRY.id, dimensions: {} },
      { id: LINE_2, journal_entry_id: OPEN_ENTRY.id, dimensions: {} },
    ],
    error: null,
  },
  journal_entries: { data: [CLOSED_ENTRY, OPEN_ENTRY], error: null },
  ...LOCKS,
}
const PERIOD_CLOSED = 'Perioden är stängd: använd rättelseverifikat (storno) för att ändra dimensioner.'

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
      expect(client.calls.some((c) => c.table === 'journal_entry_lines' || (c.table === 'rpc' && !isIdempotencyClaim(c)))).toBe(false)
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
      outcome: 'partial',
      retagged: 2,
      unchanged: 0,
      failed_count: 1,
      failed_by_reason: [{ reason: 'line_not_found', lines: 1, message: 'Verifikationsraden hittades inte.' }],
      failed: [{ line_id: LINE_FOREIGN, error: 'Verifikationsraden hittades inte.', reason: 'line_not_found' }],
      mode: 'merge',
    })
    const rpcCalls = client.calls.filter((c) => c.table === 'rpc' && !isIdempotencyClaim(c))
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

  // crm#1313: an agent could tag a line but never take a tag off it.
  it('an empty code removes that dimension and keeps the others (merge)', async () => {
    const client = makeClient({
      company_members: MEMBER,
      journal_entry_lines: {
        data: [{ id: LINE_1, journal_entry_id: 'entry-1', account_number: '1930', dimensions: { '1': 'KS01', '6': 'P001' } }],
        error: null,
      },
      journal_entries: { data: [OPEN_ENTRY], error: null },
      ...LOCKS,
      account_dimension_rules: { data: [], error: null },
      rpc: { data: { changed: true }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await retag(post({ line_ids: [LINE_1], dimensions: { '6': '' }, reason: REASON }), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ retagged: 1, failed_count: 0, mode: 'merge' })
    expect(client.calls.find((c) => c.table === 'rpc' && !isIdempotencyClaim(c))?.args[0]).toMatchObject({
      p_line_id: LINE_1,
      p_dimensions: { '1': 'KS01' },
    })
  })

  it('refuses to take off a dimension the line\'s account requires, without calling the RPC', async () => {
    const client = makeClient({
      company_members: MEMBER,
      journal_entry_lines: {
        data: [{ id: LINE_1, journal_entry_id: 'entry-1', account_number: '4010', dimensions: { '6': 'P001' } }],
        error: null,
      },
      journal_entries: { data: [OPEN_ENTRY], error: null },
      ...LOCKS,
      account_dimension_rules: {
        data: [{ account_number: '4010', rule_type: 'required', dimensions: { sie_dim_no: 6, name: 'Projekt' }, dimension_values: null }],
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await retag(post({ line_ids: [LINE_1], dimensions: { '6': '' }, reason: REASON }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('DIMENSION_RETAG_FAILED')
    expect(body.error.details.failed).toEqual([
      {
        line_id: LINE_1,
        error: 'Konto 4010 kräver Projekt: dimensionen kan inte tas bort från raden.',
        reason: 'required_dimension',
        entry_date: '2026-03-01',
      },
    ])
    expect(client.calls.some((c) => c.table === 'rpc' && !isIdempotencyClaim(c))).toBe(false)
  })

  it('replace sends exactly the given bag: the line\'s own dimensions are not kept', async () => {
    const client = makeClient({ company_members: MEMBER, ...LINES, rpc: { data: { changed: true }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await retag(
      post({ line_ids: [LINE_1], dimensions: { '6': 'P001' }, mode: 'replace', reason: REASON }),
      params,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ outcome: 'complete', retagged: 1, mode: 'replace' })
    // LINE_1 carries kostnadsställe KS01: a replace leaves it out.
    expect(client.calls.find((c) => c.table === 'rpc' && !isIdempotencyClaim(c))?.args[0]).toMatchObject({
      p_line_id: LINE_1,
      p_dimensions: { '6': 'P001' },
    })
  })

  it('a line in a closed year is left untagged, the open year is tagged, and the 200 says partial (crm#1908)', async () => {
    const client = makeClient({
      company_members: MEMBER,
      ...LINES_ACROSS_YEAR_END,
      rpc: { data: { changed: true }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await retag(post({ line_ids: [LINE_1, LINE_2], dimensions: { '6': 'P001' }, reason: REASON }), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      outcome: 'partial',
      retagged: 1,
      unchanged: 0,
      failed_count: 1,
      failed_by_reason: [
        { reason: 'period_closed', lines: 1, message: PERIOD_CLOSED, date_from: '2025-12-20', date_to: '2025-12-20' },
      ],
      failed: [{ line_id: LINE_1, error: PERIOD_CLOSED, reason: 'period_closed', entry_date: '2025-12-20' }],
      mode: 'merge',
    })
    // The line behind the lock never reaches the RPC.
    const rpcCalls = client.calls.filter((c) => c.table === 'rpc' && !isIdempotencyClaim(c))
    expect(rpcCalls.map((c) => (c.args[0] as { p_line_id: string }).p_line_id)).toEqual([LINE_2])
  })

  it('400 DIMENSION_RETAG_FAILED with every refusal when no line could be retagged', async () => {
    const client = makeClient({
      company_members: MEMBER,
      ...LINES,
      // Locked after the lock check: the RPC refuses.
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
      reason: 'refused',
      entry_date: '2026-03-01',
    })
    expect(body.error.details.failed_by_reason).toMatchObject([{ reason: 'refused', lines: 2 }])
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
      taggable_lines: 1,
      missing_line_ids: [LINE_FOREIGN],
      refused_lines: [],
      blocked_lines: [],
      blocked_by_reason: [],
      unchanged_lines: 0,
    })
    expect(routeRpcCalls(client.rpc)).toEqual([])
  })

  it('a dry run names the lines the commit will leave untagged, and why', async () => {
    const client = makeClient({ company_members: MEMBER, ...LINES_ACROSS_YEAR_END })
    mockServiceClient.mockReturnValue(client)
    const res = await retag(
      post({ line_ids: [LINE_1, LINE_2], dimensions: { '6': 'P001' }, reason: REASON }, '?dry_run=true'),
      params,
    )
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.preview).toMatchObject({
      taggable_lines: 1,
      blocked_lines: [{ line_id: LINE_1, error: PERIOD_CLOSED, reason: 'period_closed', entry_date: '2025-12-20' }],
      blocked_by_reason: [
        { reason: 'period_closed', lines: 1, message: PERIOD_CLOSED, date_from: '2025-12-20', date_to: '2025-12-20' },
      ],
      lines: [
        { line_id: LINE_1, dimensions_before: {}, dimensions_after: { '6': 'P001' }, blocked: 'period_closed' },
        { line_id: LINE_2, dimensions_before: {}, dimensions_after: { '6': 'P001' } },
      ],
    })
    expect(routeRpcCalls(client.rpc)).toEqual([])
  })
})
