/**
 * POST /api/v1/companies/:companyId/pending-operations/:id/reject
 *
 * The write is rejectPendingOperations (shared with the app and MCP): a
 * compare-and-set on status pending. The pending_operations double keeps that
 * semantics so a reject of an operation that is no longer pending is seen to
 * change nothing.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const audit = vi.hoisted(() => ({ appendProcessingHistory: vi.fn() }))

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
vi.mock('@/lib/processing-history/append', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/processing-history/append')>()),
  appendProcessingHistory: (...args: unknown[]) => audit.appendProcessingHistory(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OP_ID = '11111111-1111-4111-8111-111111111111'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const URL_ = `https://x.test/api/v1/companies/${COMPANY_ID}/pending-operations/${OP_ID}/reject`
const params = { params: Promise.resolve({ companyId: COMPANY_ID, id: OP_ID }) }

type Row = Record<string, unknown>

function operationRow(overrides: Row = {}): Row {
  return {
    id: OP_ID,
    company_id: COMPANY_ID,
    operation_type: 'create_supplier',
    status: 'pending',
    title: 'Skapa leverantör',
    preview_data: { name: 'Exempel AB' },
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-stager',
    actor_label: 'Attestflöde',
    risk_level: 'low',
    rejection_category: null,
    rejection_reason: null,
    batch_id: null,
    created_at: '2026-10-15T09:00:00.000Z',
    resolved_at: null,
    ...overrides,
  }
}

/** Reads answer the row (a list for `.in()`), an update matches only while pending. */
function client(initial: Row | null) {
  const state = { row: initial ? { ...initial } : null }
  const resolver: TableMockResolver = (calls) => {
    const update = calls.find((c) => c.method === 'update')
    const asList = calls.some((c) => c.method === 'in')
    if (!state.row) return { data: asList ? [] : null }
    if (update) {
      const onlyWhilePending = calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'pending')
      if (onlyWhilePending && state.row.status !== 'pending') return { data: [] }
      state.row = { ...state.row, ...(update.args[0] as Row) }
      return { data: [{ id: OP_ID }] }
    }
    return { data: asList ? [{ ...state.row }] : { ...state.row } }
  }
  const mock = createTableMockSupabase({ company_members: OWNER, pending_operations: resolver })
  mockServiceClient.mockReturnValue(mock.supabase)
  return { ...mock, state }
}

function request(body?: unknown): Request {
  return new Request(URL_, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'key-approver',
    apiKeyName: 'Attestflöde',
    scopes: ['pending_operations:approve'],
    mode: 'live',
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    unattendedCommitLimit: null,
  })
  audit.appendProcessingHistory.mockResolvedValue(undefined)
})

describe('POST .../pending-operations/:id/reject', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    const { state } = client(operationRow())
    expect((await POST(request(), params)).status).toBe(401)
    expect(state.row?.status).toBe('pending')
  })

  it('400 for a reason over 500 characters or a category a person cannot give, changing nothing', async () => {
    for (const body of [{ reason: 'x'.repeat(501) }, { category: 'expired' }, { reason: 'ok', extra: 1 }]) {
      const { state } = client(operationRow())
      const res = await POST(request(body), params)
      expect(res.status).toBe(400)
      expect(state.row?.status).toBe('pending')
    }
  })

  it('404 PENDING_OPERATION_NOT_FOUND for an id outside the company', async () => {
    client(null)
    const res = await POST(request(), params)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('PENDING_OPERATION_NOT_FOUND')
  })

  it('409 PENDING_OPERATION_NOT_PENDING for an operation already committed, leaving it committed', async () => {
    const { state } = client(operationRow({ status: 'committed', result_data: { supplier_id: 's-1' } }))
    const res = await POST(request({ reason: 'För sent' }), params)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('PENDING_OPERATION_NOT_PENDING')
    expect(body.error.details.pending_operation).toMatchObject({ status: 'committed', task_state: 'completed' })
    expect(state.row?.status).toBe('committed')
  })

  it('200 with the rejected operation, task_state cancelled, recorded as the API door', async () => {
    const { state } = client(operationRow())
    const res = await POST(request({ category: 'wrong_amount', reason: '  Beloppet stämmer inte.  ' }), params)

    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({
      pending_operation_id: OP_ID,
      status: 'rejected',
      task_state: 'cancelled',
      rejection_category: 'wrong_amount',
      rejection_reason: 'Beloppet stämmer inte.',
    })
    expect(state.row?.result_data).toMatchObject({ rejected_by: 'user-1', rejected_via: 'api_key', actor_id: 'key-approver' })
    expect(audit.appendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PendingOperationRejected',
        payload: expect.objectContaining({ channel: 'api' }),
      }),
    )
  })

  it("keeps the stager's agent_reason on the rejected operation: the rejection is the decision it is kept with", async () => {
    const reason = 'Acme AB is on three supplier invoices in the inbox.'
    const { state, findCalls } = client(operationRow({ agent_reason: reason }))
    const res = await POST(request({ category: 'wrong_amount', reason: 'Fel leverantör.' }), params)

    expect(res.status).toBe(200)
    const { data } = await res.json()
    // The approver's reason and the agent's stay apart.
    expect(data).toMatchObject({ status: 'rejected', rejection_reason: 'Fel leverantör.', agent_reason: reason })
    expect(state.row?.agent_reason).toBe(reason)
    // The rejection never writes agent_reason.
    for (const [payload] of findCalls('pending_operations', 'update')) expect(payload).not.toHaveProperty('agent_reason')
  })

  it('answers the rejected operation without agent_reason while that column is not there yet', async () => {
    const state = { row: operationRow() as Row }
    let viewReads = 0
    const mock = createTableMockSupabase({
      company_members: OWNER,
      pending_operations: (calls) => {
        const update = calls.find((c) => c.method === 'update')
        if (update) {
          state.row = { ...state.row, ...(update.args[0] as Row) }
          return { data: [{ id: OP_ID }] }
        }
        if (calls.some((c) => c.method === 'in')) return { data: [{ ...state.row }] }
        viewReads += 1
        const select = calls.find((c) => c.method === 'select')?.args[0] as string
        if (select.includes('agent_reason')) return { data: null, error: { code: '42703', message: 'no agent_reason' } }
        return { data: { ...state.row } }
      },
    })
    mockServiceClient.mockReturnValue(mock.supabase)

    const res = await POST(request({ category: 'wrong_amount' }), params)

    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ status: 'rejected', agent_reason: null })
    expect(viewReads).toBe(2)
  })

  it('an empty body rejects without a category', async () => {
    const { state } = client(operationRow())
    const res = await POST(request(), params)
    expect(res.status).toBe(200)
    expect(state.row?.status).toBe('rejected')
    expect(state.row?.rejection_category).toBeNull()
  })
})
