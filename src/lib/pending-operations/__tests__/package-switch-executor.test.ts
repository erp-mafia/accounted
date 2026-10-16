/**
 * The executors behind enable_package and disable_package (Profiles and
 * Suggestions, step 3), reached through commitPendingOperation. Both call
 * set_company_package_choice (migration 20261016200400) on the service
 * client with the approving user and credential; the database re-checks that
 * the approver is an owner or admin and refuses to switch a package off
 * while it has open obligations. A service account's own key never decides.
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

function makeOp(
  operationType: 'enable_package' | 'disable_package',
  params: Record<string, unknown> = { package_id: 'payroll', source: 'suggestion', suggestion_key: 'enable_package:payroll' },
): PendingOperation {
  return {
    id: 'op-1',
    user_id: OWNER_ID,
    company_id: COMPANY_ID,
    operation_type: operationType,
    status: 'pending',
    title: operationType === 'enable_package' ? 'Slå på Lön?' : 'Dölj Lön?',
    params,
    preview_data: { package: 'Lön', reason: 'Du har registrerat en anställd.' },
    result_data: null,
    actor_type: 'system',
    actor_id: null,
    actor_label: 'Accounted',
    risk_level: 'low',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-10-16T09:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-16T09:00:00Z',
  }
}

function serviceClient(rpc: { data?: unknown; error?: unknown }) {
  const mock = createTableMockSupabase({ 'rpc:set_company_package_choice': rpc })
  service.current = mock.supabase
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  service.current = null
})

describe('commitPendingOperation: enable_package and disable_package', () => {
  it('switches the package on through the service client, as the approver and credential', async () => {
    const svc = serviceClient({ data: { ok: true, unchanged: false, capability_config_id: 'cfg-1', decided_at: '2026-10-16T10:00:00Z' } })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T10:00:00Z' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // finalize

    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('enable_package'), {
      commitMethod: 'api_key',
      actor: { type: 'api_key', label: 'Claude' },
    })

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({
      package_id: 'payroll',
      package_name: 'Lön',
      enabled: true,
      changed: true,
      capability_config_id: 'cfg-1',
      decided_at: '2026-10-16T10:00:00Z',
    })
    expect(svc.findCall('rpc:set_company_package_choice', 'rpc')).toEqual([
      {
        p_company_id: COMPANY_ID,
        p_package_id: 'payroll',
        p_enabled: true,
        p_source: 'suggestion',
        p_decided_by: OWNER_ID,
        p_actor_type: 'api_key',
        p_actor_label: 'Claude',
        p_pending_operation_id: 'op-1',
      },
    ])
    // The session client never calls the service_role-only RPC.
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).not.toContain('set_company_package_choice')
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toMatchObject({ status: 'committed' })
  })

  it('refuses to switch off while the package has open obligations: rejected with them named', async () => {
    serviceClient({ data: { ok: false, code: 'PACKAGE_HAS_OPEN_OBLIGATIONS', obligations: ['active_employees'] } })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T10:00:00Z' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      OWNER_ID,
      COMPANY_ID,
      makeOp('disable_package', { package_id: 'payroll', source: 'suggestion', suggestion_key: 'disable_package:payroll' }),
      { commitMethod: 'user_accept', actor: { type: 'user', label: 'anna@example.se' } },
    )

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'PACKAGE_HAS_OPEN_OBLIGATIONS',
      error: 'Lön kan inte stängas av medan det finns aktiva anställda.',
      http_status: 409,
      data: { obligations: ['active_employees'] },
      operation_status: 'rejected',
    })
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toMatchObject({
      status: 'rejected',
      rejection_category: 'failed',
    })
  })

  it('hands a non-admin approval back to pending', async () => {
    serviceClient({ data: { ok: false, code: 'PACKAGE_SWITCH_ADMIN_REQUIRED' } })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T10:00:00Z' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('enable_package'), {
      commitMethod: 'user_accept',
      actor: { type: 'user' },
    })

    expect(result).toMatchObject({ status: 'failed', code: 'PACKAGE_SWITCH_ADMIN_REQUIRED', http_status: 403, operation_status: 'pending' })
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toEqual({ status: 'pending' })
  })

  it("never lets a service account's own key decide", async () => {
    const svc = serviceClient({ data: { ok: true } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T10:00:00Z' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('enable_package'), {
      commitMethod: 'api_key',
      actor: { type: 'service_account', label: 'Nattlig synk' },
    })

    expect(result).toMatchObject({ status: 'failed', code: 'PACKAGE_SWITCH_NEEDS_PERSON', operation_status: 'pending' })
    expect(svc.findCall('rpc:set_company_package_choice', 'rpc')).toBeUndefined()
  })

  it('refuses a staged row whose package is not switchable', async () => {
    const svc = serviceClient({ data: { ok: true } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T10:00:00Z' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      OWNER_ID,
      COMPANY_ID,
      makeOp('disable_package', { package_id: 'bookkeeping' }),
      { commitMethod: 'user_accept', actor: { type: 'user' } },
    )

    expect(result).toMatchObject({ status: 'failed', http_status: 400, operation_status: 'rejected' })
    expect(svc.findCall('rpc:set_company_package_choice', 'rpc')).toBeUndefined()
  })
})
