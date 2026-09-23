/**
 * GET /api/v1/companies/:companyId/salary-runs/:id/payment-files
 *
 * The archived payment files of a run, newest first, content inline.
 * Proxy-backed Supabase mock with per-table response queues (the
 * employees-route pattern); only auth and the client are mocked.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `payment-files route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listPaymentFiles } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

interface RecordedCall {
  table: string
  method: string
  args: unknown[]
}

function makeRecordingSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const calls: RecordedCall[] = []
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve({ data: next.data ?? null, error: next.error ?? null })
          }
        }
        return (...args: unknown[]) => {
          calls.push({ table, method: String(prop), args })
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  const supabase = {
    from: vi.fn((table: string) => buildChain(table)),
  }
  return { supabase, calls }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FILE_NEW = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1'
const FILE_OLD = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'
const USER_ID = 'user-1'
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/payment-files`

function makeRequest(url: string): Request {
  return new Request(url, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function listParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

const XML = '<?xml version="1.0" encoding="UTF-8"?><Document/>'
const LB = '11123456700000000000260325LÖN 2026-04\r\n29\r\n'

const newerRow = {
  id: FILE_NEW,
  format: 'pain001',
  filename: 'pain001_lon_2026-04.xml',
  content_type: 'application/xml',
  charset: 'utf-8',
  sha256: 'a'.repeat(64),
  byte_size: 51,
  payment_date: '2026-04-24',
  employee_count: 2,
  // PostgREST may serialize numeric as a string on some stacks; the route
  // normalizes it.
  total_amount: '45000',
  generated_at: '2026-04-20T10:00:00.000Z',
  content: XML,
}

const olderRow = {
  id: FILE_OLD,
  format: 'bg_lb',
  filename: 'bg_lb_lon_2026-04.txt',
  content_type: 'text/plain',
  charset: 'iso-8859-1',
  sha256: 'b'.repeat(64),
  byte_size: 44,
  payment_date: '2026-04-24',
  employee_count: 2,
  total_amount: 45000,
  generated_at: '2026-04-19T09:00:00.000Z',
  content: LB,
}

function happyTables(overrides: Record<string, TableResp | TableResp[]> = {}) {
  return {
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' } },
    salary_runs: { data: { id: RUN_ID } },
    salary_payment_files: { data: [newerRow, olderRow] },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Payroll operator',
    scopes: ['payroll:read'],
    mode: 'live',
  })
})

describe('GET /salary-runs/:id/payment-files', () => {
  it('returns 401 without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeRecordingSupabase({}).supabase)

    const res = await listPaymentFiles(new Request(URL), listParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(401)
    expect(mockValidate).not.toHaveBeenCalled()
  })

  it('returns 401 UNAUTHORIZED for an invalid API key', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeRecordingSupabase({}).supabase)

    const res = await listPaymentFiles(makeRequest(URL), listParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 403 INSUFFICIENT_SCOPE without payroll:read', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'Invoices only',
      scopes: ['invoices:read'],
      mode: 'live',
    })
    const { supabase, calls } = makeRecordingSupabase(happyTables())
    mockServiceClient.mockReturnValue(supabase)

    const res = await listPaymentFiles(makeRequest(URL), listParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(calls.filter((c) => c.table === 'salary_payment_files')).toHaveLength(0)
  })

  it('rejects a non-UUID run id with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(makeRecordingSupabase(happyTables()).supabase)

    const res = await listPaymentFiles(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/not-a-uuid/payment-files`),
      listParams(COMPANY_ID, 'not-a-uuid'),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 SALARY_RUN_NOT_FOUND for a run outside the company', async () => {
    const { supabase, calls } = makeRecordingSupabase(happyTables({ salary_runs: { data: null } }))
    mockServiceClient.mockReturnValue(supabase)

    const res = await listPaymentFiles(makeRequest(URL), listParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
    // The run lookup is company-scoped; the archive is never queried.
    const runLookup = calls.filter((c) => c.table === 'salary_runs' && c.method === 'eq')
    expect(runLookup.map((c) => c.args)).toContainEqual(['company_id', COMPANY_ID])
    expect(calls.filter((c) => c.table === 'salary_payment_files')).toHaveLength(0)
  })

  it('lists the archived files newest first with content, digest and charset', async () => {
    const { supabase, calls } = makeRecordingSupabase(happyTables())
    mockServiceClient.mockReturnValue(supabase)

    const res = await listPaymentFiles(makeRequest(URL), listParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data).toHaveLength(2)
    expect(body.data[0]).toEqual({
      payment_file_id: FILE_NEW,
      format: 'pain001',
      filename: 'pain001_lon_2026-04.xml',
      content_type: 'application/xml',
      charset: 'utf-8',
      sha256: 'a'.repeat(64),
      byte_size: 51,
      payment_date: '2026-04-24',
      employee_count: 2,
      total_amount: 45000,
      generated_at: '2026-04-20T10:00:00.000Z',
      content: XML,
    })
    expect(body.data[1].payment_file_id).toBe(FILE_OLD)
    expect(body.data[1].charset).toBe('iso-8859-1')
    expect(body.data[1].content).toBe(LB)
    // Final page: no cursor.
    expect(body.meta.next_cursor ?? null).toBeNull()

    // Company-scoped, run-scoped, newest first.
    const archiveCalls = calls.filter((c) => c.table === 'salary_payment_files')
    expect(archiveCalls.map((c) => [c.method, ...c.args])).toEqual(
      expect.arrayContaining([
        ['eq', 'company_id', COMPANY_ID],
        ['eq', 'salary_run_id', RUN_ID],
        ['order', 'generated_at', { ascending: false }],
        ['order', 'id', { ascending: false }],
      ]),
    )
  })

  it('returns an empty list for a run with no archived file yet', async () => {
    mockServiceClient.mockReturnValue(
      makeRecordingSupabase(happyTables({ salary_payment_files: { data: [] } })).supabase,
    )

    const res = await listPaymentFiles(makeRequest(URL), listParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
  })

  it('pages with limit and hands out a cursor when more rows remain', async () => {
    const { supabase, calls } = makeRecordingSupabase(happyTables())
    mockServiceClient.mockReturnValue(supabase)

    const res = await listPaymentFiles(makeRequest(`${URL}?limit=1`), listParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].payment_file_id).toBe(FILE_NEW)
    expect(typeof body.meta.next_cursor).toBe('string')
    // limit + 1 rows are fetched to detect the next page.
    const limitCall = calls.find((c) => c.table === 'salary_payment_files' && c.method === 'limit')
    expect(limitCall?.args).toEqual([2])

    // Following the cursor filters strictly older rows (generated_at DESC, id DESC).
    const { supabase: page2, calls: calls2 } = makeRecordingSupabase(
      happyTables({ salary_payment_files: { data: [olderRow] } }),
    )
    mockServiceClient.mockReturnValue(page2)
    const res2 = await listPaymentFiles(
      makeRequest(`${URL}?limit=1&cursor=${encodeURIComponent(body.meta.next_cursor)}`),
      listParams(COMPANY_ID, RUN_ID),
    )
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.data.map((r: { payment_file_id: string }) => r.payment_file_id)).toEqual([FILE_OLD])
    expect(body2.meta.next_cursor ?? null).toBeNull()
    const orFilter = calls2.find((c) => c.table === 'salary_payment_files' && c.method === 'or')
    expect(orFilter?.args[0]).toBe(
      `generated_at.lt.2026-04-20T10:00:00.000Z,and(generated_at.eq.2026-04-20T10:00:00.000Z,id.lt.${FILE_NEW})`,
    )
  })
})
