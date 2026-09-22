import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { requestSIEJobAction } from '../sie-jobs'
import { getStructuredError } from '@/lib/errors/get-structured-error'

const db = createQueuedMockSupabase()
const call = (action: 'undo' | 'resume') => requestSIEJobAction(db.supabase as unknown as SupabaseClient, 'company-1', 'user-1', 'import-1', action)

describe('SIE action legacy preflight', () => {
  beforeEach(() => { vi.clearAllMocks(); db.reset() })

  it.each(['undo', 'resume'] as const)('refuses legacy %s before any mutating RPC', async action => {
    db.enqueue({ data: { id: 'import-1', job_state: null } })
    const error = await call(action).catch(value => value)
    expect(getStructuredError(error)).toMatchObject({ code: 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED', retryable: false,
      remediation: { tool: 'gnubok_sie_import_status' } })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
    expect(db.findCalls('sie_imports', 'eq')).toEqual([['company_id', 'company-1'], ['id', 'import-1']])
  })

  it.each(['undo', 'resume'] as const)('leaves durable %s authorization and lock checks to the existing RPC', async action => {
    const job = { id: 'import-1', job_state: 'paused' }
    db.enqueueMany([{ data: job }, { data: job }])
    expect(await call(action)).toEqual(job)
    expect(db.supabase.rpc).toHaveBeenCalledWith(action === 'undo' ? 'request_sie_import_undo' : 'resume_sie_import_job', {
      p_company_id: 'company-1', p_import_id: 'import-1', p_actor: 'user-1',
    })
  })

  it('returns a missing/inaccessible result without an RPC', async () => {
    db.enqueue({ data: null })
    await expect(call('undo')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it('preserves lookup failures instead of guessing legacy or missing state', async () => {
    const error = { code: '57014', message: 'statement timeout' }
    db.enqueue({ error })
    await expect(call('undo')).rejects.toEqual(error)
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it('preserves a durable RPC lock refusal', async () => {
    db.enqueueMany([{ data: { id: 'import-1', job_state: 'completed' } }, { error: { code: 'P0001', message: 'period is locked' } }])
    await expect(call('undo')).rejects.toThrow('period is locked')
    expect(db.supabase.rpc).toHaveBeenCalledOnce()
  })
})
