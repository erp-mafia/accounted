/**
 * GET /api/v1/companies/:companyId/pending-operations and
 * GET /api/v1/companies/:companyId/pending-operations/:id
 *
 * The approval queue and one operation over REST: the view never carries the
 * staged params, every row has task_state beside status, the list defaults
 * to pending and pages on (created_at, id) descending.
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { encodeDefaultCursor } from '@/lib/api/v1/pagination'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { GET as LIST } from '../route'
import { GET as DETAIL } from '../[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/pending-operations`
const listParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function row(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `0000000${n}-0000-4000-8000-000000000000`,
    company_id: COMPANY_ID,
    batch_id: null,
    operation_type: 'create_supplier',
    title: `Skapa leverantör ${n}`,
    preview_data: { name: `Leverantör ${n}` },
    status: 'pending',
    risk_level: 'low',
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Attestflöde',
    rejection_category: null,
    rejection_reason: null,
    result_data: null,
    created_at: `2026-10-1${n}T09:00:00.000Z`,
    resolved_at: null,
    ...overrides,
  }
}

function client(pendingOperations: TableMockResult | TableMockResult[]) {
  const mock = createTableMockSupabase({ company_members: OWNER, pending_operations: pendingOperations })
  mockServiceClient.mockReturnValue(mock.supabase)
  return mock
}

function get(url: string): Request {
  return new Request(url, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'key-1',
    apiKeyName: 'Attestflöde',
    scopes: ['pending_operations:read'],
    mode: 'live',
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    unattendedCommitLimit: null,
  })
})

describe('GET .../pending-operations', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    client({ data: [] })
    expect((await LIST(get(BASE), listParams)).status).toBe(401)
  })

  it('403 INSUFFICIENT_SCOPE for a key without pending_operations:read', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'key-1',
      apiKeyName: 'Fakturor',
      scopes: ['invoices:read'],
      mode: 'live',
      allowedCompanyIds: null,
      readOnlyCompanyIds: null,
      unattendedCommitLimit: null,
    })
    client({ data: [] })
    expect((await LIST(get(BASE), listParams)).status).toBe(403)
  })

  it('400 for an unknown status or risk level', async () => {
    for (const query of ['?status=approved', '?risk_level=extreme', '?batch_id=nope']) {
      const mock = client({ data: [] })
      const res = await LIST(get(`${BASE}${query}`), listParams)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
      expect(mock.tables()).not.toContain('pending_operations')
    }
  })

  it('lists pending operations newest first with task_state and no params, paging by cursor', async () => {
    const mock = client({ data: [row(3), row(2), row(1)] })

    const res = await LIST(get(`${BASE}?limit=2`), listParams)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.data[0]).toMatchObject({
      pending_operation_id: row(3).id,
      status: 'pending',
      task_state: 'working',
      preview: { name: 'Leverantör 3' },
      links: { approve: `/api/v1/companies/${COMPANY_ID}/pending-operations/${row(3).id}/approve` },
    })
    expect(body.data[0]).not.toHaveProperty('params')
    expect(body.meta.next_cursor).toBe(encodeDefaultCursor(row(2)))
    // Default status pending, company-scoped, descending.
    expect(mock.findCalls('pending_operations', 'eq')).toEqual(
      expect.arrayContaining([['company_id', COMPANY_ID], ['status', 'pending']]),
    )
    expect(mock.findCall('pending_operations', 'order')).toEqual(['created_at', { ascending: false }])
    expect(mock.payloads('pending_operations', 'select')[0]).not.toContain('params')
  })

  it("answers each operation's agent_reason, null when its stager gave none", async () => {
    const mock = client({ data: [row(2, { agent_reason: 'Acme AB is on three invoices in the inbox.' }), row(1, { agent_reason: null })] })
    const body = await (await LIST(get(BASE), listParams)).json()
    expect(body.data.map((op: { agent_reason: string | null }) => op.agent_reason)).toEqual([
      'Acme AB is on three invoices in the inbox.',
      null,
    ])
    expect(mock.payloads('pending_operations', 'select')[0]).toContain('agent_reason')
  })

  it("answers each operation's operation_number, the number a person sees", async () => {
    const mock = client({ data: [row(2, { operation_number: 129 }), row(1, { operation_number: 128 })] })
    const body = await (await LIST(get(BASE), listParams)).json()
    expect(body.data.map((op: { operation_number: number | null }) => op.operation_number)).toEqual([129, 128])
    expect(mock.payloads('pending_operations', 'select')[0]).toContain('operation_number')
  })

  it('lists without operation_number while that column is not there yet, and keeps agent_reason', async () => {
    const mock = client([
      { data: null, error: { code: '42703', message: 'column pending_operations.operation_number does not exist' } },
      { data: [row(1, { agent_reason: 'Acme AB is on three invoices in the inbox.' })] },
    ])
    const res = await LIST(get(BASE), listParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].operation_number).toBeNull()
    expect(body.data[0].agent_reason).toBe('Acme AB is on three invoices in the inbox.')
    const selects = mock.payloads('pending_operations', 'select') as string[]
    expect(selects).toHaveLength(2)
    expect(selects[1]).not.toContain('operation_number')
    expect(selects[1]).toContain('agent_reason')
    // The retry keeps every filter of the first read.
    expect(mock.findCalls('pending_operations', 'eq').filter(([column]) => column === 'status')).toHaveLength(2)
  })

  it('status=all drops the status filter, a cursor continues below it, and the last page has no next_cursor', async () => {
    const mock = client({
      data: [row(1, { status: 'committed', result_data: { supplier_id: 's-1' } }), row(2, { status: 'rejected', rejection_category: 'expired' })],
    })
    const cursor = encodeDefaultCursor(row(3))

    const res = await LIST(get(`${BASE}?status=all&cursor=${cursor}`), listParams)

    const body = await res.json()
    expect(body.data.map((op: { task_state: string }) => op.task_state)).toEqual(['completed', 'cancelled'])
    expect(body.meta.next_cursor).toBeUndefined()
    expect(mock.findCalls('pending_operations', 'eq').some(([column]) => column === 'status')).toBe(false)
    expect(mock.findCall('pending_operations', 'or')?.[0]).toBe(
      `created_at.lt.${row(3).created_at},and(created_at.eq.${row(3).created_at},id.lt.${row(3).id})`,
    )
  })
})

describe('GET .../pending-operations/:id', () => {
  const id = row(1).id
  const detailParams = { params: Promise.resolve({ companyId: COMPANY_ID, id }) }

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    client({ data: row(1) })
    expect((await DETAIL(get(`${BASE}/${id}`), detailParams)).status).toBe(401)
  })

  it('400 for an id that is not a UUID', async () => {
    client({ data: null })
    const res = await DETAIL(get(`${BASE}/abc`), { params: Promise.resolve({ companyId: COMPANY_ID, id: 'abc' }) })
    expect(res.status).toBe(400)
  })

  it('404 PENDING_OPERATION_NOT_FOUND for an id outside the company', async () => {
    const mock = client({ data: null })
    const res = await DETAIL(get(`${BASE}/${id}`), detailParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('PENDING_OPERATION_NOT_FOUND')
    expect(mock.findCalls('pending_operations', 'eq')).toEqual(expect.arrayContaining([['company_id', COMPANY_ID]]))
  })

  it('200 with agent_reason and operation_number, read without the number while that column is not there yet', async () => {
    client({ data: row(1, { agent_reason: 'Same supplier as the last eleven.', operation_number: 128 }) })
    expect((await (await DETAIL(get(`${BASE}/${id}`), detailParams)).json()).data).toMatchObject({
      agent_reason: 'Same supplier as the last eleven.',
      operation_number: 128,
    })

    const mock = client([{ data: null, error: { code: '42703', message: 'no operation_number' } }, { data: row(1) }])
    const res = await DETAIL(get(`${BASE}/${id}`), detailParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ pending_operation_id: id, operation_number: null })
    expect(mock.payloads('pending_operations', 'select')).toHaveLength(2)
  })

  it('200 with the operation and its outcome', async () => {
    client({ data: row(1, { status: 'failed_partial', result_data: { posted_ids: { journal_entry_id: 'je-1' } } }) })
    const res = await DETAIL(get(`${BASE}/${id}`), detailParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({
      pending_operation_id: id,
      status: 'failed_partial',
      task_state: 'failed',
      result: { posted_ids: { journal_entry_id: 'je-1' } },
    })
  })
})
