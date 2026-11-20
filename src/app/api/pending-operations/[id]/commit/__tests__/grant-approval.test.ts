/**
 * Accepting a rule for automatic booking (create_grant) is a person's
 * decision in the app. This walks the browser's own approval door, POST
 * /api/pending-operations/:id/commit, through the real withRouteContext
 * (which opens runWithActor({ type: 'user' })) and the real
 * commitPendingOperation (which opens its own scope with the route's actor),
 * and asserts the executor reached create_company_grant as 'user'. The
 * database refuses every other actor type (tests/pg/company-grants.pg.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'

const { supabase: session, enqueue, reset, findCalls } = createQueuedMockSupabase()
const service = vi.hoisted(() => ({ current: null as unknown }))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
  requireCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => service.current),
}))

import { POST } from '../route'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const GRANT_ID = '33333333-3333-4333-8333-333333333333'

const OP = {
  id: 'op-1',
  user_id: OWNER_ID,
  company_id: COMPANY_ID,
  operation_type: 'create_grant',
  status: 'pending',
  title: 'Godkänn Spotify AB automatiskt nästa gång, upp till 200 kr?',
  params: {
    operation_type: 'categorize_transaction',
    counterparty_key: 'spotify',
    counterparty_label: 'Spotify AB',
    pattern: {
      direction: 'out',
      category: 'expense_software',
      vat_treatment: 'standard_25',
      reverse_charge_kind: null,
      account_number: '5420',
      line_accounts: ['1930', '2641', '5420'],
    },
    amount_limit_sek: 200,
    monthly_limit_sek: null,
    credential: { kind: 'any' },
    source: 'suggestion',
    suggestion_key: 'create_grant:cp-0123456789abcdef',
  },
  preview_data: {},
  result_data: null,
  actor_type: 'system',
  actor_id: null,
  actor_label: 'Accounted',
  risk_level: 'high',
  agent_metadata: null,
  created_at: '2026-10-16T09:00:00Z',
  resolved_at: null,
  updated_at: '2026-10-16T09:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  vi.stubEnv('GRANT_SUGGESTIONS', 'true')
  requireAuthMock.mockResolvedValue({ user: { id: OWNER_ID, email: 'anna@example.se' }, supabase: session, error: null })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/pending-operations/:id/commit for create_grant', () => {
  it('reaches the executor as the person: create_company_grant is called with actor type user', async () => {
    const svc = createTableMockSupabase({
      'rpc:create_company_grant': { data: { ok: true, grant_id: GRANT_ID, version: 1, superseded_grant_id: null, valid_from: '2026-10-16T10:00:00Z' } },
    })
    service.current = svc.supabase
    enqueue({ data: OP }) // the route's read of the operation
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T10:00:00Z' } }) // the commit's claim
    enqueue({ data: null }) // finalize

    const res = await POST(new Request('http://localhost/api/pending-operations/op-1/commit', { method: 'POST' }), {
      params: Promise.resolve({ id: 'op-1' }),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ grant_id: GRANT_ID, version: 1 })
    expect(svc.findCall('rpc:create_company_grant', 'rpc')?.[0]).toMatchObject({
      p_decided_by: OWNER_ID,
      p_actor_type: 'user',
      p_actor_label: 'anna@example.se',
    })
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toMatchObject({ status: 'committed' })
  })

  it('answers the switch being off with a coded refusal, and accepts nothing', async () => {
    vi.stubEnv('GRANT_SUGGESTIONS', 'false')
    const svc = createTableMockSupabase({ 'rpc:create_company_grant': { data: { ok: true } } })
    service.current = svc.supabase
    enqueue({ data: OP })
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T10:00:00Z' } })
    enqueue({ data: null })

    const res = await POST(new Request('http://localhost/api/pending-operations/op-1/commit', { method: 'POST' }), {
      params: Promise.resolve({ id: 'op-1' }),
    })

    expect(res.status).toBe(409)
    expect(svc.findCall('rpc:create_company_grant', 'rpc')).toBeUndefined()
  })
})
