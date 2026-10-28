/**
 * POST /api/v1/companies/:companyId/pending-operations/:id/approve
 *
 * Runs the real commitPendingOperation against a pending_operations double
 * with the table's compare-and-set semantics (the claim is a conditional
 * UPDATE on status 'pending'), so "approving twice never commits twice" is
 * tested through the same claim production relies on. The executor behind
 * the operation (ignore_transaction) is mocked and counted.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const executor = vi.hoisted(() => ({ setTransactionIgnored: vi.fn() }))
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
vi.mock('@/lib/transactions/ignore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/ignore')>()),
  setTransactionIgnored: (...args: unknown[]) => executor.setTransactionIgnored(...args),
}))
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
const TX_ID = '22222222-2222-4222-8222-222222222222'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const URL_ = `https://x.test/api/v1/companies/${COMPANY_ID}/pending-operations/${OP_ID}/approve`
const params = { params: Promise.resolve({ companyId: COMPANY_ID, id: OP_ID }) }

type Row = Record<string, unknown>

function operationRow(overrides: Row = {}): Row {
  return {
    id: OP_ID,
    user_id: 'user-1',
    company_id: COMPANY_ID,
    operation_type: 'ignore_transaction',
    status: 'pending',
    title: 'Ignorera transaktion',
    params: { transaction_id: TX_ID, ignored: true },
    preview_data: { transaction_id: TX_ID },
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-stager',
    actor_label: 'Attestflöde',
    risk_level: 'low',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    batch_id: null,
    created_at: '2026-10-15T09:00:00.000Z',
    resolved_at: null,
    updated_at: '2026-10-15T09:00:00.000Z',
    ...overrides,
  }
}

/**
 * pending_operations with the table's semantics: a read answers the current
 * row, an UPDATE filtered on status 'pending' matches only while it is.
 */
function pendingOperationsTable(initial: Row | null) {
  const state = { row: initial ? { ...initial } : null }
  const resolver: TableMockResolver = (calls) => {
    if (!state.row) return { data: null }
    const update = calls.find((c) => c.method === 'update')
    if (!update) return { data: { ...state.row } }
    const onlyWhilePending = calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'pending')
    if (onlyWhilePending && state.row.status !== 'pending') return { data: null }
    state.row = { ...state.row, ...(update.args[0] as Row) }
    return { data: { id: OP_ID } }
  }
  return { state, resolver }
}

function client(initial: Row | null) {
  const table = pendingOperationsTable(initial)
  const mock = createTableMockSupabase({ company_members: OWNER, pending_operations: table.resolver })
  mockServiceClient.mockReturnValue(mock.supabase)
  return { ...mock, state: table.state }
}

function request(body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...headers,
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
    scopes: ['pending_operations:read', 'pending_operations:approve'],
    mode: 'live',
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    unattendedCommitLimit: null,
  })
  executor.setTransactionIgnored.mockResolvedValue({
    ok: true,
    transaction_id: TX_ID,
    is_ignored: true,
    changed: true,
  })
  audit.appendProcessingHistory.mockResolvedValue(undefined)
})

describe('POST .../pending-operations/:id/approve', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    client(operationRow())
    expect((await POST(request(), params)).status).toBe(401)
    expect(executor.setTransactionIgnored).not.toHaveBeenCalled()
  })

  it('403 INSUFFICIENT_SCOPE for a key without pending_operations:approve', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'key-reader',
      apiKeyName: 'Läsnyckel',
      scopes: ['pending_operations:read'],
      mode: 'live',
      allowedCompanyIds: null,
      readOnlyCompanyIds: null,
      unattendedCommitLimit: null,
    })
    client(operationRow())
    const res = await POST(request(), params)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('INSUFFICIENT_SCOPE')
    expect(executor.setTransactionIgnored).not.toHaveBeenCalled()
  })

  it('400 without an Idempotency-Key, for a malformed id and for an unknown body key, committing nothing', async () => {
    const noKey = new Request(URL_, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
    })
    client(operationRow())
    expect((await POST(noKey, params)).status).toBe(400)

    client(operationRow())
    const badId = await POST(request(), { params: Promise.resolve({ companyId: COMPANY_ID, id: 'not-a-uuid' }) })
    expect(badId.status).toBe(400)

    client(operationRow())
    const badBody = await POST(request({ confirmed: 'yes' }), params)
    expect(badBody.status).toBe(400)
    expect((await badBody.json()).error.code).toBe('VALIDATION_ERROR')

    const { state } = client(operationRow())
    expect((await POST(request({ approve: true }), params)).status).toBe(400)
    expect(state.row?.status).toBe('pending')
    expect(executor.setTransactionIgnored).not.toHaveBeenCalled()
  })

  it('400 PENDING_OPERATION_CONFIRMATION_REQUIRED for high risk without confirmed=true, still pending', async () => {
    const { state } = client(operationRow({ risk_level: 'high' }))
    const res = await POST(request({}), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('PENDING_OPERATION_CONFIRMATION_REQUIRED')
    expect(body.error.details.pending_operation).toMatchObject({ status: 'pending', task_state: 'working' })
    expect(state.row?.status).toBe('pending')
    expect(executor.setTransactionIgnored).not.toHaveBeenCalled()
  })

  it('404 PENDING_OPERATION_NOT_FOUND for an id outside the company', async () => {
    client(null)
    const res = await POST(request(), params)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('PENDING_OPERATION_NOT_FOUND')
  })

  it('403 COLLECTION_ATTESTATION_WEB_ONLY for an operation only a person approves in the app', async () => {
    const { state } = client(operationRow({ operation_type: 'open_collection_case', params: { invoice_id: TX_ID } }))
    const res = await POST(request(), params)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('COLLECTION_ATTESTATION_WEB_ONLY')
    expect(state.row?.status).toBe('pending')
  })

  it('403 GRANT_NEEDS_PERSON for a rule for automatic booking: only a person accepts it, in Att göra', async () => {
    const { state } = client(operationRow({ operation_type: 'create_grant', risk_level: 'high', params: { counterparty_key: 'spotify' } }))
    const res = await POST(request({ confirmed: true }), params)
    expect(res.status).toBe(403)
    const { error } = await res.json()
    expect(error.code).toBe('GRANT_NEEDS_PERSON')
    expect(error.message).toMatch(/Att göra/)
    expect(state.row?.status).toBe('pending')
  })

  it('200 with the committed outcome, attributed to the key', async () => {
    const { state } = client(operationRow())
    const res = await POST(request(), params)

    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({
      pending_operation_id: OP_ID,
      status: 'committed',
      task_state: 'completed',
      result: { transaction_id: TX_ID, is_ignored: true, changed: true },
    })
    expect(data).not.toHaveProperty('params')
    expect(state.row?.status).toBe('committed')
    expect(executor.setTransactionIgnored).toHaveBeenCalledTimes(1)
    expect(audit.appendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PendingOperationApproved',
        payload: expect.objectContaining({ channel: 'api', commit_method: 'api_key', outcome: 'committed' }),
        actor: expect.objectContaining({ type: 'api_key', id: 'key-approver' }),
      }),
    )
  })

  it("answers the committed operation with the stager's agent_reason", async () => {
    client(operationRow({ agent_reason: 'Duplicate of the line booked on the 3rd.' }))
    const res = await POST(request(), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ status: 'committed', agent_reason: 'Duplicate of the line booked on the 3rd.' })
  })

  it('approving twice commits once: the second answers 409 with the committed operation', async () => {
    const { state } = client(operationRow())

    const first = await POST(request(), params)
    const second = await POST(request(), params)

    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    const body = await second.json()
    expect(body.error.code).toBe('PENDING_OPERATION_NOT_PENDING')
    expect(body.error.details.pending_operation).toMatchObject({ status: 'committed', task_state: 'completed' })
    expect(state.row?.status).toBe('committed')
    expect(executor.setTransactionIgnored).toHaveBeenCalledTimes(1)
  })

  it('two concurrent approvals commit once: the claim lets one through', async () => {
    client(operationRow())

    const responses = await Promise.all([POST(request(), params), POST(request(), params)])

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect(executor.setTransactionIgnored).toHaveBeenCalledTimes(1)
  })

  it('a refused commit names where the operation landed: released to pending stays re-approvable', async () => {
    // A 403 from the executor is released back to pending by the commit.
    executor.setTransactionIgnored.mockResolvedValue({ ok: false, code: 'FORBIDDEN', status: 403 })
    const { state } = client(operationRow())

    const res = await POST(request(), params)

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.details.pending_operation).toMatchObject({ status: 'pending', task_state: 'working' })
    expect(state.row?.status).toBe('pending')
  })

  it('an executor refusal that resolves the operation answers 409 COMMIT_FAILED with task_state failed', async () => {
    // The transaction is gone: the commit auto-rejects (executor 404).
    executor.setTransactionIgnored.mockResolvedValue({ ok: false, code: 'TRANSACTION_NOT_FOUND_X', status: 404 })
    client(operationRow())

    const res = await POST(request(), params)

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('PENDING_OPERATION_COMMIT_FAILED')
    expect(body.error.details.commit_error_code).toBe('TRANSACTION_NOT_FOUND_X')
    expect(body.error.details.pending_operation).toMatchObject({ status: 'rejected', task_state: 'failed' })
  })
})
