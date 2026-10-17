/**
 * The executors behind create_grant and revoke_grant (Profiles and
 * Suggestions, step 4; lib/grants), reached through commitPendingOperation,
 * and the commit's own guard on the grant option. Both executors call their
 * SECURITY DEFINER function on the service client with the approving user
 * and credential; the database re-checks that the approver is an owner or
 * admin. A service account's own key never decides a grant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const GRANT_ID = '33333333-3333-4333-8333-333333333333'

const CREATE_PARAMS = {
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
  evidence: { booking_count: 5, max_amount_sek: 139, last_booked: '2026-05-03' },
  source: 'suggestion',
  suggestion_key: 'create_grant:cp-0123456789abcdef',
}

function makeOp(operationType: string, params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: OWNER_ID,
    company_id: COMPANY_ID,
    operation_type: operationType,
    status: 'pending',
    title: 'Godkänn Spotify AB automatiskt nästa gång, upp till 200 kr?',
    params,
    preview_data: { reason: 'Samma motpart bokad på samma sätt 5 gånger.' },
    result_data: null,
    actor_type: 'system',
    actor_id: null,
    actor_label: 'Accounted',
    risk_level: 'high',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-10-16T09:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-16T09:00:00Z',
  } as PendingOperation
}

function sessionClient() {
  const queued = createQueuedMockSupabase()
  queued.enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T10:00:00Z' }, error: null }) // CAS claim
  queued.enqueue({ data: null, error: null }) // finalize
  return queued
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  service.current = null
  vi.stubEnv('GRANT_SUGGESTIONS', 'true')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** How the app's commit route approves: the person, on their own session. */
const PERSON = { commitMethod: 'user_accept' as const, actor: { type: 'user' as const, label: 'anna@example.se' } }

describe('commitPendingOperation: create_grant', () => {
  it('creates the grant through the service client when the person approves it in the app', async () => {
    const svc = createTableMockSupabase({
      'rpc:create_company_grant': { data: { ok: true, grant_id: GRANT_ID, version: 1, superseded_grant_id: null, valid_from: '2026-10-16T10:00:00Z' } },
    })
    service.current = svc.supabase
    const { supabase, findCalls } = sessionClient()

    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('create_grant', CREATE_PARAMS), PERSON)

    expect(result).toMatchObject({
      status: 'committed',
      data: { grant_id: GRANT_ID, version: 1, superseded_grant_id: null, counterparty_label: 'Spotify AB', amount_limit_sek: 200 },
    })
    expect(svc.findCall('rpc:create_company_grant', 'rpc')).toEqual([
      expect.objectContaining({
        p_company_id: COMPANY_ID,
        p_decided_by: OWNER_ID,
        p_actor_type: 'user',
        p_actor_label: 'anna@example.se',
        p_pending_operation_id: 'op-1',
        p_operation_type: 'categorize_transaction',
        p_counterparty_key: 'spotify',
        p_direction: 'out',
        p_category: 'expense_software',
        p_vat_treatment: 'standard_25',
        p_account_number: '5420',
        p_line_accounts: ['1930', '2641', '5420'],
        p_amount_limit_sek: 200,
        p_monthly_limit_sek: null,
        p_credential_scope: 'any',
        p_credential_id: null,
      }),
    ])
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toMatchObject({ status: 'committed' })
  })

  it('hands a non-admin approval back to pending', async () => {
    service.current = createTableMockSupabase({ 'rpc:create_company_grant': { data: { ok: false, code: 'GRANT_ADMIN_REQUIRED' } } }).supabase
    const { supabase, findCalls } = sessionClient()
    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('create_grant', CREATE_PARAMS), PERSON)
    expect(result).toMatchObject({ status: 'failed', code: 'GRANT_ADMIN_REQUIRED', http_status: 403, operation_status: 'pending' })
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toEqual({ status: 'pending' })
  })

  it('never lets an agent accept a grant: every key, the OAuth connector, the in-app assistant, a service account, no actor', async () => {
    const svc = createTableMockSupabase({ 'rpc:create_company_grant': { data: { ok: true } } })
    service.current = svc.supabase
    for (const opts of [
      { commitMethod: 'api_key' as const, actor: { type: 'api_key' as const, label: 'Claude' } },
      { commitMethod: 'api_key' as const, actor: { type: 'mcp_oauth' as const, label: 'Claude (Anthropic)' } },
      { commitMethod: 'agent' as const, actor: { type: 'agent_chat' as const } },
      { commitMethod: 'api_key' as const, actor: { type: 'service_account' as const, label: 'Nattlig synk' } },
      { commitMethod: 'user_accept' as const },
      // A person's actor through a door that is not the app's own approval.
      { commitMethod: 'bulk_accept' as const, actor: { type: 'user' as const } },
    ]) {
      const { supabase, findCalls } = createQueuedMockSupabase()
      const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('create_grant', CREATE_PARAMS), opts)
      expect(result).toMatchObject({ status: 'failed', code: 'GRANT_NEEDS_PERSON', http_status: 403, operation_status: 'pending' })
      expect(result.error).toMatch(/Att göra/)
      // Refused before the claim: the suggestion still waits for the person.
      expect(findCalls('pending_operations', 'update')).toEqual([])
    }
    expect(svc.findCall('rpc:create_company_grant', 'rpc')).toBeUndefined()
  })

  it('refuses every grant while GRANT_SUGGESTIONS is off, even approved by the person', async () => {
    vi.stubEnv('GRANT_SUGGESTIONS', 'false')
    const svc = createTableMockSupabase({ 'rpc:create_company_grant': { data: { ok: true } } })
    service.current = svc.supabase
    const { supabase } = sessionClient()
    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('create_grant', CREATE_PARAMS), PERSON)
    expect(result).toMatchObject({ code: 'GRANTS_SWITCHED_OFF', http_status: 409, operation_status: 'rejected' })
    expect(result.error).toMatch(/avstängda/)
    expect(svc.findCall('rpc:create_company_grant', 'rpc')).toBeUndefined()
  })

  it('refuses tampered params: representation, a pattern without its account, a monthly limit below the limit', async () => {
    const svc = createTableMockSupabase({ 'rpc:create_company_grant': { data: { ok: true } } })
    service.current = svc.supabase
    for (const params of [
      { ...CREATE_PARAMS, pattern: { ...CREATE_PARAMS.pattern, category: 'expense_representation' } },
      { ...CREATE_PARAMS, pattern: { ...CREATE_PARAMS.pattern, line_accounts: ['1930', '2641'] } },
      { ...CREATE_PARAMS, monthly_limit_sek: 100 },
      { ...CREATE_PARAMS, extra: true },
    ]) {
      const { supabase } = sessionClient()
      const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('create_grant', params), PERSON)
      expect(result).toMatchObject({ status: 'failed', http_status: 400, operation_status: 'rejected' })
    }
    expect(svc.findCall('rpc:create_company_grant', 'rpc')).toBeUndefined()
  })
})

describe('commitPendingOperation: revoke_grant', () => {
  it('revokes and answers the postings the grant let through', async () => {
    const postings = [{ use_id: 'u1', journal_entry_id: 'je-1', amount_sek: 149, entry_date: '2026-06-03' }]
    const svc = createTableMockSupabase({
      'rpc:revoke_company_grant': {
        data: { ok: true, unchanged: false, grant_id: GRANT_ID, version: 1, counterparty_label: 'Spotify AB', revoked_at: '2026-10-16T11:00:00Z', postings_count: 1, postings },
      },
    })
    service.current = svc.supabase
    const { supabase } = sessionClient()
    const result = await commitPendingOperation(
      supabase as never,
      OWNER_ID,
      COMPANY_ID,
      makeOp('revoke_grant', { grant_id: GRANT_ID, counterparty_label: 'Spotify AB' }),
      { commitMethod: 'user_accept', actor: { type: 'user', label: 'anna@example.se' } },
    )
    expect(result).toMatchObject({
      status: 'committed',
      data: { grant_id: GRANT_ID, changed: true, postings_count: 1, postings },
    })
    expect(svc.findCall('rpc:revoke_company_grant', 'rpc')).toEqual([
      { p_company_id: COMPANY_ID, p_grant_id: GRANT_ID, p_decided_by: OWNER_ID, p_actor_type: 'user', p_actor_label: 'anna@example.se', p_pending_operation_id: 'op-1' },
    ])
  })

  it('lets any approver revoke, a key included, and while the switch is off: it only takes authority away', async () => {
    vi.stubEnv('GRANT_SUGGESTIONS', 'false')
    const svc = createTableMockSupabase({
      'rpc:revoke_company_grant': { data: { ok: true, unchanged: false, grant_id: GRANT_ID, version: 1, counterparty_label: 'Spotify AB', postings_count: 0, postings: [] } },
    })
    service.current = svc.supabase
    const { supabase } = sessionClient()
    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('revoke_grant', { grant_id: GRANT_ID }), {
      commitMethod: 'api_key',
      actor: { type: 'api_key', label: 'Claude' },
    })
    expect(result).toMatchObject({ status: 'committed', data: { grant_id: GRANT_ID, changed: true } })
    expect(svc.findCall('rpc:revoke_company_grant', 'rpc')?.[0]).toMatchObject({ p_actor_type: 'api_key' })
  })

  it('auto-rejects a revoke of a grant that does not exist', async () => {
    service.current = createTableMockSupabase({ 'rpc:revoke_company_grant': { data: { ok: false, code: 'GRANT_NOT_FOUND' } } }).supabase
    const { supabase } = sessionClient()
    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('revoke_grant', { grant_id: GRANT_ID }), {
      commitMethod: 'user_accept',
      actor: { type: 'user' },
    })
    expect(result).toMatchObject({ code: 'GRANT_NOT_FOUND', http_status: 404, operation_status: 'rejected' })
  })
})

describe('commitPendingOperation: the grant option', () => {
  it('refuses a grant on an operation type no grant covers, or for an actor that is not a key, before the claim', async () => {
    for (const [op, actor] of [
      [makeOp('create_customer', { name: 'X' }), { type: 'api_key' as const, label: 'Claude' }],
      [makeOp('categorize_transaction', { transaction_id: 't1', category: 'expense_software' }), { type: 'user' as const }],
    ] as const) {
      const { supabase, findCalls } = createQueuedMockSupabase()
      const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, op, {
        commitMethod: 'api_key',
        actor,
        grant: { grantId: GRANT_ID, grantVersion: 1, useId: 'use-1' },
      })
      expect(result).toMatchObject({ status: 'failed', code: 'GRANT_NOT_APPLICABLE', http_status: 403, operation_status: 'pending' })
      expect(findCalls('pending_operations', 'update')).toEqual([])
    }
  })
})
