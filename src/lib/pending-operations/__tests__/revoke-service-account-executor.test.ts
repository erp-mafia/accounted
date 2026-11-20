/**
 * commitRevokeServiceAccount: the executor behind a staged
 * revoke_service_account (gnubok_revoke_service_account), reached through
 * commitPendingOperation. The revocation runs revoke_service_account
 * (migration 20261016120000) on the service client in every commit path,
 * with the approving user as the revoker; the database re-checks that the
 * approver is an owner or admin. A service account's own key never approves
 * it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

const service = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => service.current),
}))

import { commitPendingOperation } from '../commit'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const ACCOUNT_ID = '5b6c1d2e-0000-4000-8000-0000000000a1'

const REVOKED_ROW = {
  id: ACCOUNT_ID,
  company_id: COMPANY_ID,
  name: 'Nattlig synk',
  sponsor_user_id: OWNER_ID,
  created_by: OWNER_ID,
  created_at: '2026-10-16T08:00:00Z',
  revoked_at: '2026-10-16T10:00:00Z',
  revoked_by: OWNER_ID,
}

function makeOp(params: Record<string, unknown> = { service_account_id: ACCOUNT_ID }): PendingOperation {
  return {
    id: 'op-1',
    user_id: OWNER_ID,
    company_id: COMPANY_ID,
    operation_type: 'revoke_service_account',
    status: 'pending',
    title: 'Återkalla tjänstekontot Nattlig synk',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Admin key',
    risk_level: 'high',
    created_at: '2026-10-16T09:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-16T09:00:00Z',
  } as PendingOperation
}

function serviceClient(rpc: { data?: unknown; error?: unknown }) {
  const mock = createTableMockSupabase({
    'rpc:revoke_service_account': rpc,
    company_members: { data: [{ user_id: OWNER_ID, role: 'owner' }] },
    companies: { data: { archived_at: null } },
  })
  service.current = mock.supabase
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  service.current = null
})

describe('commitPendingOperation: revoke_service_account', () => {
  it('revokes through the service client as the approver, with the approving credential as the actor', async () => {
    const svc = serviceClient({ data: REVOKED_ROW })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // finalize

    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp(), {
      commitMethod: 'user_accept',
      actor: { type: 'user', label: 'anna@example.se' },
    })

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({
      service_account_id: ACCOUNT_ID,
      name: 'Nattlig synk',
      status: 'revoked',
      revoked_at: '2026-10-16T10:00:00Z',
      revoked_by: OWNER_ID,
    })
    expect(svc.findCall('rpc:revoke_service_account', 'rpc')).toEqual([
      {
        p_company_id: COMPANY_ID,
        p_service_account_id: ACCOUNT_ID,
        p_revoked_by: OWNER_ID,
        p_actor_type: 'user',
        p_actor_label: 'anna@example.se',
      },
    ])
    // The session client never calls the service_role-only RPC.
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).not.toContain('revoke_service_account')
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toMatchObject({ status: 'committed' })
  })

  it('records an MCP approval by a person key as api_key', async () => {
    const svc = serviceClient({ data: REVOKED_ROW })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp(), {
      commitMethod: 'api_key',
      actor: { type: 'api_key', label: 'Admin key' },
    })

    expect(result.status).toBe('committed')
    expect(svc.findCall('rpc:revoke_service_account', 'rpc')?.[0]).toMatchObject({
      p_actor_type: 'api_key',
      p_actor_label: 'Admin key',
    })
  })

  it("hands an approval by a service account's own key back to pending, and revokes nothing", async () => {
    const svc = serviceClient({ data: REVOKED_ROW })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // release to pending

    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp(), {
      commitMethod: 'api_key',
      actor: { type: 'service_account', label: 'Nattlig synk' },
    })

    expect(result).toMatchObject({
      status: 'failed',
      http_status: 403,
      code: 'SERVICE_ACCOUNT_KEY_NOT_PERMITTED',
      operation_status: 'pending',
    })
    expect(svc.findCalls('rpc:revoke_service_account', 'rpc')).toEqual([])
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toEqual({ status: 'pending' })
  })

  it("keeps the op pending when the database refuses a member's approval", async () => {
    serviceClient({ data: null, error: { message: 'SERVICE_ACCOUNT_ADMIN_REQUIRED: only an owner or admin may revoke a service account' } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(supabase as never, 'member-1', COMPANY_ID, makeOp(), {
      commitMethod: 'user_accept',
      actor: { type: 'user' },
    })

    expect(result).toMatchObject({
      status: 'failed',
      http_status: 403,
      code: 'SERVICE_ACCOUNT_ADMIN_REQUIRED',
      operation_status: 'pending',
    })
  })

  it('auto-rejects the op when the account is not the company\'s (the RPC answers a NULL row)', async () => {
    serviceClient({ data: { id: null, company_id: null, name: null } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp(), {
      commitMethod: 'user_accept',
      actor: { type: 'user' },
    })

    expect(result).toMatchObject({ status: 'rejected', http_status: 404, code: 'SERVICE_ACCOUNT_NOT_FOUND' })
  })

  it('re-validates the staged params at the commit boundary', async () => {
    const svc = serviceClient({ data: REVOKED_ROW })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp({ service_account_id: 'not-a-uuid' }), {
      commitMethod: 'user_accept',
      actor: { type: 'user' },
    })

    expect(result).toMatchObject({ status: 'failed', http_status: 400 })
    expect(svc.findCalls('rpc:revoke_service_account', 'rpc')).toEqual([])
  })
})
