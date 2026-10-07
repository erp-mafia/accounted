import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { jobDatabaseError, requestSIEJobAction } from '../sie-jobs'
import { errorResponse, getStructuredError } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { userFacingCode } from '@/lib/errors/user-facing'

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

// crm#1022: the undo, the resume of an undo and the replacement refuse a
// locked range before anything is queued. The database writes the sentence;
// it has to reach the reader whole, not as "En konflikt uppstod".
describe('SIE lock refusal', () => {
  const sentence =
    'Bokföringen är låst t.o.m. 2025-12-31, och ångringen bokför storno med de importerade verifikationernas datum, ' +
    '2024-03-04 till 2024-12-31. Lås upp till och med 2024-03-04 först: sätt Bokföring låst t.o.m. till 2024-03-03 ' +
    'eller tidigare, eller töm fältet, under Inställningar > Bokföring och försök igen. Lås bokföringen igen när ångringen är klar.'
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  beforeEach(() => { vi.clearAllMocks(); db.reset() })

  it('becomes SIE_IMPORT_PERIOD_LOCKED carrying the sentence without its prefix', () => {
    const error = jobDatabaseError({ code: '55000', message: `SIE_IMPORT_PERIOD_LOCKED: ${sentence}` })
    expect(error).toMatchObject({ code: 'SIE_IMPORT_PERIOD_LOCKED', pgCode: '55000', message: sentence })
    expect(userFacingCode(error)).toBe('SIE_IMPORT_PERIOD_LOCKED')
  })

  it('keeps every other 55000 refusal a CONFLICT', () => {
    const error = jobDatabaseError({ code: '55000', message: 'Another SIE execution must finish before undo' })
    expect(error.code).toBe('CONFLICT')
    expect(userFacingCode(error)).toBeNull()
  })

  it.each(['undo', 'resume'] as const)('answers a refused %s with a 409 whose message the dashboard shows as is', async action => {
    db.enqueueMany([{ data: { id: 'import-1', job_state: 'paused' } },
      { error: { code: '55000', message: `SIE_IMPORT_PERIOD_LOCKED: ${sentence}` } }])
    const error = await call(action).catch(value => value)
    const response = errorResponse(error, log as never, { requestId: 'req-1' })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).toMatchObject({ code: 'SIE_IMPORT_PERIOD_LOCKED', message: sentence })
    expect(getErrorMessage(body)).toBe(sentence)
    expect(getStructuredError(error)).toMatchObject({ code: 'SIE_IMPORT_PERIOD_LOCKED', message_sv: sentence, retryable: false,
      remediation: { tool: 'gnubok_update_bookkeeping_lock' } })
  })
})
