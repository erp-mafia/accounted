/**
 * GET /api/v1/companies/:companyId/dimensions/retag-log: the immutable
 * history of dimension tag changes on posted lines (operation
 * dimensions.retag-log over lib/dimensions/retag-log.ts), which no door
 * served before. Filters by journal entry and/or line, pages with offset.
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
import { GET as readLog } from '../retag-log/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

function makeClient(byTable: Record<string, TableResp>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(byTable[key] ?? { data: null, error: null })
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc: vi.fn(() => buildChain('rpc')) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LINE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LOG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'viewer' }, error: null }
const URL_ = `https://x.test/api/v1/companies/${COMPANY_ID}/dimensions/retag-log`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

const get = (query = '') =>
  readLog(new Request(`${URL_}${query}`, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } }), params)

const LOG_ROW = {
  id: LOG_ID,
  journal_entry_id: ENTRY_ID,
  line_id: LINE_ID,
  old_dimensions: { '1': 'KS01' },
  new_dimensions: { '1': 'KS01', '6': 'P001' },
  actor: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  reason: 'Projektet saknades',
  created_at: '2026-09-28T09:14:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/dimensions/retag-log', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await get()).status).toBe(401)
  })

  it('404 NOT_FOUND for a company the key cannot reach', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: { data: null, error: null } }))
    expect((await get()).status).toBe(404)
  })

  it('400 VALIDATION_ERROR for a journal_entry_id that is not a uuid or a page size past 200', async () => {
    for (const query of ['?journal_entry_id=A12', '?limit=500']) {
      mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
      const res = await get(query)
      expect(res.status, query).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('200 a page of one entry\'s history, newest first, with qualified ids', async () => {
    const client = makeClient({
      company_members: MEMBER,
      dimension_retag_log: { data: [LOG_ROW], error: null, count: 3 },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await get(`?journal_entry_id=${ENTRY_ID}&limit=1&offset=1`)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toEqual({
      entries: [
        {
          retag_log_id: LOG_ID,
          journal_entry_id: ENTRY_ID,
          line_id: LINE_ID,
          old_dimensions: { '1': 'KS01' },
          new_dimensions: { '1': 'KS01', '6': 'P001' },
          actor: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          reason: 'Projektet saknades',
          created_at: '2026-09-28T09:14:00Z',
        },
      ],
      count: 1,
      total_count: 3,
      has_more: true,
      next_offset: 2,
    })
    const eqs = client.calls.filter((c) => c.table === 'dimension_retag_log' && c.method === 'eq').map((c) => c.args)
    expect(eqs).toEqual([
      ['company_id', COMPANY_ID],
      ['journal_entry_id', ENTRY_ID],
    ])
    expect(client.calls.find((c) => c.table === 'dimension_retag_log' && c.method === 'range')?.args).toEqual([1, 1])
  })

  it('an empty page for an id that matches nothing, never a 404', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, dimension_retag_log: { data: [], error: null, count: 0 } }),
    )
    const res = await get(`?line_id=${LINE_ID}`)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ entries: [], count: 0, total_count: 0, has_more: false })
  })
})
