/**
 * POST /api/v1/companies/:companyId/pending-operations/:id/withdraw
 *
 * The key that staged an operation takes it back (crm#1725, crm#1817). The
 * write is withdrawPendingOperation, shared with the MCP tool; these tests
 * are the door: any valid key gets in, ownership decides, and the answer is
 * the operation as it stands.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const audit = vi.hoisted(() => ({ append: vi.fn(async (..._a: unknown[]) => 'event-1') }))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  validateApiKey: vi.fn(),
  createServiceClientNoCookies: vi.fn(),
}))
vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: vi.fn().mockReturnValue({}),
}))
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/multi-user')>()),
  getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }),
  isMembershipDormant: () => false,
}))
vi.mock('@/lib/processing-history/append', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/processing-history/append')>()),
  appendProcessingHistory: (...args: unknown[]) => audit.append(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { operationRowDouble, type OperationRow } from '@/lib/pending-operations/__tests__/operation-row-double'
import { WITHDRAWN_LEAD } from '@/lib/pending-operations/withdraw'
import { POST } from '../route'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OP_ID = '11111111-1111-4111-8111-111111111111'
const STAGER_KEY = 'key-stager'
const URL_ = `https://x.test/api/v1/companies/${COMPANY_ID}/pending-operations/${OP_ID}/withdraw`
const routeParams = (id: string = OP_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

function stagedRow(overrides: OperationRow = {}): OperationRow {
  return {
    id: OP_ID,
    company_id: COMPANY_ID,
    user_id: 'user-1',
    operation_type: 'create_supplier',
    status: 'pending',
    title: 'Skapa leverantör',
    preview_data: { name: 'Exempel AB' },
    result_data: null,
    actor_type: 'api_key',
    actor_id: STAGER_KEY,
    actor_label: 'Integrationen',
    risk_level: 'low',
    rejection_category: null,
    rejection_reason: null,
    batch_id: null,
    created_at: '2026-10-15T09:00:00.000Z',
    resolved_at: null,
    ...overrides,
  }
}

function database(initial: OperationRow | null, role: string = 'owner') {
  const { state, resolver } = operationRowDouble(initial)
  const mock = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role }, error: null },
    pending_operations: resolver,
  })
  vi.mocked(createServiceClientNoCookies).mockReturnValue(mock.supabase as never)
  return { ...mock, state }
}

function key(apiKeyId: string | undefined, scopes: string[] = ['suppliers:write']) {
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId,
    apiKeyName: 'Integrationen',
    scopes,
    mode: 'live',
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    unattendedCommitLimit: null,
  } as never)
}

function request(body?: unknown, headers: Record<string, string> = { 'Idempotency-Key': crypto.randomUUID() }): Request {
  return new Request(URL_, {
    method: 'POST',
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key', 'Content-Type': 'application/json', ...headers },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  key(STAGER_KEY)
})

describe('POST /pending-operations/:id/withdraw', () => {
  it('401 without a valid key', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({ error: 'invalid' } as never)
    database(stagedRow())

    const response = await POST(request(), routeParams())

    expect(response.status).toBe(401)
  })

  it('400 without an Idempotency-Key, and writes nothing', async () => {
    const { state } = database(stagedRow())

    const response = await POST(request(undefined, {}), routeParams())

    expect(response.status).toBe(400)
    expect(state.updates).toEqual([])
  })

  it.each([
    ['an id that is no UUID', undefined, 'not-a-uuid'],
    ['a body that is not JSON', '{nope', OP_ID],
    ['an unknown body field', { category: 'duplicate' }, OP_ID],
    ['an empty reason', { reason: '   ' }, OP_ID],
    ['a reason over the limit', { reason: 'x'.repeat(301) }, OP_ID],
  ])('400 for %s', async (_what, body, id) => {
    const { state } = database(stagedRow())

    const response = await POST(request(body), routeParams(id))

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
    expect(state.updates).toEqual([])
  })

  it('withdraws the key\'s own pending operation with no approve scope, and answers it as cancelled', async () => {
    const { state } = database(stagedRow())

    const response = await POST(request({ reason: 'Dubblett.' }), routeParams())

    expect(response.status).toBe(200)
    const { data } = await response.json()
    expect(data).toMatchObject({
      status: 'rejected',
      task_state: 'cancelled',
      rejection_category: 'superseded',
      rejection_reason: `${WITHDRAWN_LEAD}: Dubblett.`,
      result: { withdrawn: true, actor_id: STAGER_KEY },
    })
    expect(state.updates).toHaveLength(1)
    expect(audit.append).toHaveBeenCalledTimes(1)
    expect(audit.append.mock.calls[0][0]).toMatchObject({
      eventType: 'PendingOperationRejected',
      payload: { channel: 'api', withdrawn: true },
      actor: { type: 'api_key', id: STAGER_KEY },
    })
  })

  it('needs no body at all', async () => {
    const { state } = database(stagedRow())

    const response = await POST(request(), routeParams())

    expect(response.status).toBe(200)
    expect(state.row?.rejection_reason).toBe(`${WITHDRAWN_LEAD}.`)
  })

  it('is idempotent: withdrawing again answers the same operation and writes nothing more', async () => {
    const { state } = database(stagedRow())

    const first = await POST(request(), routeParams())
    const second = await POST(request(), routeParams())

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await second.json()).data.status).toBe('rejected')
    expect(state.updates).toHaveLength(1)
    expect(audit.append).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['another key', stagedRow({ actor_id: 'key-other' })],
    ['a person in the app', stagedRow({ actor_type: 'user', actor_id: null })],
    ['another user', stagedRow({ user_id: 'user-2' })],
  ])('403 for an operation staged by %s, which stays pending', async (_who, row) => {
    const { state } = database(row)

    const response = await POST(request(), routeParams())

    expect(response.status).toBe(403)
    const { error } = await response.json()
    expect(error.details).toMatchObject({ reason: 'not_staged_by_this_key', pending_operation_id: OP_ID })
    // Nothing about the operation itself.
    expect(JSON.stringify(error)).not.toContain('Skapa leverantör')
    expect(state.row?.status).toBe('pending')
    expect(audit.append).not.toHaveBeenCalled()
  })

  it('403 for a key with pending_operations:approve that did not stage it: rejecting is the other door', async () => {
    key('key-approver', ['pending_operations:approve'])
    const { state } = database(stagedRow())

    const response = await POST(request(), routeParams())

    expect(response.status).toBe(403)
    expect(state.row?.status).toBe('pending')
  })

  it.each(['committing', 'committed'])('409 for an own operation that is %s, answered as it stands', async (status) => {
    const { state } = database(stagedRow({ status }))

    const response = await POST(request(), routeParams())

    expect(response.status).toBe(409)
    const { error } = await response.json()
    expect(error.code).toBe('PENDING_OPERATION_NOT_PENDING')
    expect(error.details.pending_operation.status).toBe(status)
    expect(state.updates).toEqual([])
  })

  it('404 for an operation the company does not have', async () => {
    database(null)

    const response = await POST(request(), routeParams())

    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('PENDING_OPERATION_NOT_FOUND')
  })

  it('a read-only member\'s key is refused before anything is read: withdrawing is a write', async () => {
    const { state } = database(stagedRow(), 'viewer')

    const response = await POST(request(), routeParams())

    expect(response.status).toBe(403)
    expect(state.updates).toEqual([])
  })
})
