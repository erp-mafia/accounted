/**
 * Approving a staged account dimension rule runs the same operation the v1
 * door runs (src/lib/operations/dimension-rules.ts through
 * commitRegisteredOperation), with the staged params re-validated first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { commitPendingOperation } from '../commit'

const DIM_ID = '0e9c0000-0000-4000-8000-000000000006'
const VALUE_ID = 'a8f10000-0000-4000-8000-000000000001'
const RULE_ID = '5b7e0000-0000-4000-8000-000000000001'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_dimension_rule',
    status: 'pending',
    title: 'Dimensionsregel för konto 4010: obligatorisk',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'low',
    created_at: '2026-09-28T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-09-28T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: account dimension rules', () => {
  it('creates the approved rule', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: DIM_ID, is_active: true }, error: null }) // dimension
    enqueue({ data: { account_number: '4010' }, error: null }) // chart
    enqueue({
      data: {
        id: RULE_ID,
        account_number: '4010',
        rule_type: 'required',
        value_id: null,
        is_active: true,
        dimension: { id: DIM_ID, sie_dim_no: 6, name: 'Projekt' },
        value: null,
      },
      error: null,
    }) // insert returning RULE_SELECT
    enqueue({ data: null, error: null }) // finalize update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: { account_number: '4010', dimension_id: DIM_ID, rule_type: 'required' } }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ rule: { account_dimension_rule_id: RULE_ID, dimension_name: 'Projekt' } })
    expect(findCall('account_dimension_rules', 'insert')?.[0]).toMatchObject({
      company_id: 'company-1',
      account_number: '4010',
      rule_type: 'required',
    })
  })

  it('re-validates the staged params: a required rule with a value never reaches the table', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: { account_number: '4010', dimension_id: DIM_ID, rule_type: 'required', value_id: VALUE_ID },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.code).toBe('VALIDATION_ERROR')
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(tables).not.toContain('account_dimension_rules')
  })

  it('deletes the approved rule, and answers DIMENSION_RULE_NOT_FOUND when it is already gone', async () => {
    const gone = createQueuedMockSupabase()
    gone.enqueue({ data: { id: 'op-2' }, error: null }) // CAS claim
    gone.enqueue({ data: null, error: null, count: 0 }) // delete matched nothing
    gone.enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      gone.supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ id: 'op-2', operation_type: 'delete_dimension_rule', params: { account_dimension_rule_id: RULE_ID } }),
    )

    expect(result.code).toBe('DIMENSION_RULE_NOT_FOUND')
    expect(result.http_status).toBe(404)
  })
})
