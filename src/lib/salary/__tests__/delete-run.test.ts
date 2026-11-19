import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { deleteDraftSalaryRun } from '../delete-run'

const ARGS = { companyId: 'company-1', salaryRunId: 'run-1' }

describe('deleteDraftSalaryRun', () => {
  it('returns SALARY_RUN_NOT_FOUND when the run does not exist', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([{ data: null }])

    const result = await deleteDraftSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
    expect(findCall('salary_runs', 'delete')).toBeUndefined()
  })

  it('refuses a run that is not a draft and never writes', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'run-1', status: 'booked' } }])

    const result = await deleteDraftSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({
      ok: false,
      code: 'SALARY_RUN_DELETE_NOT_DRAFT',
      details: { current_status: 'booked' },
    })
    expect(findCall('salary_runs', 'delete')).toBeUndefined()
  })

  it('dry run stops after the pre-flight', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'run-1', status: 'draft' } }])

    const result = await deleteDraftSalaryRun(supabase as never, { ...ARGS, dryRun: true })

    expect(result).toEqual({ ok: true, data: { id: 'run-1', deleted: true } })
    expect(findCall('salary_runs', 'delete')).toBeUndefined()
  })

  it('locks the delete to a draft with no posted verifikat', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'run-1', status: 'draft' } }, { data: null, count: 1 }])

    const result = await deleteDraftSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: true, data: { id: 'run-1', deleted: true } })
    expect(findCalls('salary_runs', 'eq')).toContainEqual(['status', 'draft'])
    expect(findCalls('salary_runs', 'is')).toEqual([
      ['salary_entry_id', null],
      ['avgifter_entry_id', null],
      ['vacation_entry_id', null],
    ])
  })

  it('refuses when the locked delete matches no row (status race or a verifikat attached)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'run-1', status: 'draft' } }, { data: null, count: 0 }])

    const result = await deleteDraftSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({
      ok: false,
      code: 'SALARY_RUN_DELETE_HAS_JOURNAL_ENTRY',
      details: { reason: 'fk_non_null_or_status_race' },
    })
  })

  it('returns the raw FK error so each surface keeps its own mapping', async () => {
    const fkError = {
      code: '23503',
      message: 'update or delete on table "salary_runs" violates foreign key constraint',
      details: 'Key (id)=(run-1) is still referenced from table "salary_payment_files".',
      hint: null,
    }
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'run-1', status: 'draft' } }, { error: fkError }])

    const result = await deleteDraftSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'DB_ERROR', error: fkError })
  })
})
