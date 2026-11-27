/**
 * Recalling the approval of one run of a month summed over several runs
 * (SALARY_EXTRA_RUNS_COMPANY_IDS): the month's declaration is not deleted
 * with it, since it carries the month's tax payment tracking. The run leaves
 * the runs the declaration covers instead, so the declaration is neither paid
 * nor answered as filed until the month is generated again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'

vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn().mockResolvedValue(undefined) } }))

import { unapproveSalaryRun } from '../run-status-recall'

const COMPANY_ID = 'company-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log } as unknown as Logger

/** The rollout as the environment had it, restored after each test that sets it. */
const rolloutBefore = process.env.SALARY_EXTRA_RUNS_COMPANY_IDS

const APPROVED = {
  status: 'approved',
  is_correction: false,
  agi_submitted_at: null,
  agi_generated_at: '2026-12-01T10:00:00Z',
  payment_file_format: null,
  payment_file_generated_at: null,
}

function context(supabase: unknown): OperationContext {
  return { supabase, companyId: COMPANY_ID, userId: 'user-1', log } as unknown as OperationContext
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = COMPANY_ID
})

afterEach(() => {
  if (rolloutBefore === undefined) delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
  else process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = rolloutBefore
})

describe('unapproveSalaryRun: a run of a month with several runs', () => {
  it("keeps the month's declaration and leaves it covering no run until the month is generated again", async () => {
    const { supabase, enqueueMany, findCall, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: APPROVED }, // the run
      // The month's declaration, taken over by this run after the month was
      // filed and paid for the other run.
      { data: [{ id: 'agi-1', status: 'generated', salary_run_id: 'run-c', salary_run_ids: ['run-a', 'run-c'] }] },
      { data: { id: 'run-c', status: 'review' } }, // the status flip
      { data: null }, // the declaration's covered runs
    ])

    const result = await unapproveSalaryRun(context(supabase), 'run-c')

    expect(result).toMatchObject({ ok: true, data: { deletedAgiDeclarationId: null } })
    expect(findCall('agi_declarations', 'delete')).toBeUndefined()
    expect(findCalls('agi_declarations', 'update')).toEqual([[{ salary_run_ids: [] }]])
  })

  it("still deletes a stale declaration of the run's own month alone", async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: APPROVED },
      { data: [{ id: 'agi-2', status: 'generated', salary_run_id: 'run-c', salary_run_ids: ['run-c'] }] },
      { data: { id: 'run-c', status: 'review' } },
      { data: [{ id: 'agi-2' }] }, // the delete
    ])

    const result = await unapproveSalaryRun(context(supabase), 'run-c')

    expect(result).toMatchObject({ ok: true, data: { deletedAgiDeclarationId: 'agi-2' } })
    expect(findCall('agi_declarations', 'delete')).toBeDefined()
  })

  it('refuses while the month\'s filed declaration covers the run', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: APPROVED },
      { data: [{ id: 'agi-1', status: 'submitted', salary_run_id: 'run-a', salary_run_ids: ['run-a', 'run-c'] }] },
    ])

    const result = await unapproveSalaryRun(context(supabase), 'run-c')

    expect(result).toMatchObject({ ok: false, code: 'SALARY_RUN_UNAPPROVE_AGI_FILED' })
    expect(findCall('salary_runs', 'update')).toBeUndefined()
  })
})
