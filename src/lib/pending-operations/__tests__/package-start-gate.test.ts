/**
 * The commit-time twin of the doors' package start gate: approving a staged
 * start (a new salary run, invoice, asset, ...) starts that work, so it
 * refuses while the company has the package switched off or winding down,
 * staged before the switch or not. The operation stays pending (no claim),
 * so it commits once the package is on again. Approving anything that
 * settles open work never asks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { packageOffRefusal, packageStartRefusal } from '@/lib/modules/package-gate'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))

import { commitPendingOperation } from '../commit'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'

function makeOp(operationType: string, params: Record<string, unknown> = {}): PendingOperation {
  return {
    id: 'op-1',
    user_id: OWNER_ID,
    company_id: COMPANY_ID,
    operation_type: operationType,
    status: 'pending',
    title: 'Förslag',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: null,
    actor_label: 'Claude',
    risk_level: 'medium',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-10-16T09:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-16T09:00:00Z',
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: package start gate', () => {
  it('refuses a staged salary run while Lön is off and leaves it pending, unclaimed', async () => {
    vi.mocked(packageStartRefusal).mockResolvedValueOnce(packageOffRefusal('payroll', 'turned_off_by_company'))
    const { supabase, findCalls } = createQueuedMockSupabase()

    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('create_salary_run'))

    expect(result).toMatchObject({ status: 'failed', code: 'PACKAGE_OFF', http_status: 409, operation_status: 'pending' })
    expect(result.error).toMatch(/Slå på Lön under Anpassa\.$/)
    expect(packageStartRefusal).toHaveBeenCalledWith(supabase, COMPANY_ID, 'payroll')
    expect(findCalls('pending_operations', 'update')).toEqual([])
  })

  it('asks about the package an operation-backed start belongs to', async () => {
    vi.mocked(packageStartRefusal).mockResolvedValueOnce(packageOffRefusal('expenses', 'off_in_profile'))
    const { supabase } = createQueuedMockSupabase()
    const result = await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp('create_expense_claim'))
    expect(result).toMatchObject({ code: 'PACKAGE_OFF', operation_status: 'pending' })
    expect(packageStartRefusal).toHaveBeenCalledWith(supabase, COMPANY_ID, 'expenses')
  })

  it('never asks when the approval settles open work', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // the claim finds nothing: enough to show the gate was skipped
    for (const type of ['book_salary_run', 'mark_invoice_paid', 'generate_agi', 'disable_package']) {
      await commitPendingOperation(supabase as never, OWNER_ID, COMPANY_ID, makeOp(type))
    }
    expect(packageStartRefusal).not.toHaveBeenCalled()
  })
})
