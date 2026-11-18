import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { jobDatabaseError, requestSIEJobAction, sieUndoCommitActor } from '../sie-jobs'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
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

// WHO asked for the undo (migration 20261016005200): request_sie_import_undo
// records the actor of the request, labelled as an undo, and the undo's
// stornos stamp it. A resume records nothing new.
describe('SIE undo actor', () => {
  beforeEach(() => { vi.clearAllMocks(); db.reset() })

  it('labels the actor as an undo, keeping its credential name', () => {
    expect(sieUndoCommitActor({ type: 'api_key', label: 'Byrånyckel' })).toEqual({ type: 'api_key', label: 'SIE undo: Byrånyckel' })
    expect(sieUndoCommitActor({ type: 'user' })).toEqual({ type: 'user', label: 'SIE undo' })
    expect(sieUndoCommitActor(undefined)).toBeUndefined()
  })

  it('sends the undo actor of the current scope to request_sie_import_undo', async () => {
    const job = { id: 'import-1', job_state: 'undoing' }
    db.enqueueMany([{ data: { id: 'import-1', job_state: 'completed' } }, { data: job }])
    await runWithActor({ type: 'mcp_oauth', label: 'Claude' }, () => call('undo'))
    expect(db.supabase.rpc).toHaveBeenCalledWith('request_sie_import_undo', {
      p_company_id: 'company-1', p_import_id: 'import-1', p_actor: 'user-1',
      p_actor_type: 'mcp_oauth', p_actor_label: 'SIE undo: Claude',
    })
  })

  it('retries once without the actor against a database that predates it (PGRST202)', async () => {
    const job = { id: 'import-1', job_state: 'undoing' }
    db.enqueueMany([
      { data: { id: 'import-1', job_state: 'completed' } },
      { error: { code: 'PGRST202', message: 'Could not find the function public.request_sie_import_undo' } },
      { data: job },
    ])
    expect(await runWithActor({ type: 'user' }, () => call('undo'))).toEqual(job)
    expect(db.supabase.rpc).toHaveBeenCalledTimes(2)
    expect(db.supabase.rpc).toHaveBeenLastCalledWith('request_sie_import_undo', {
      p_company_id: 'company-1', p_import_id: 'import-1', p_actor: 'user-1',
    })
  })

  it('never sends an actor with a resume', async () => {
    const job = { id: 'import-1', job_state: 'paused' }
    db.enqueueMany([{ data: job }, { data: job }])
    await runWithActor({ type: 'api_key', label: 'Byrånyckel' }, () => call('resume'))
    expect(db.supabase.rpc).toHaveBeenCalledWith('resume_sie_import_job', {
      p_company_id: 'company-1', p_import_id: 'import-1', p_actor: 'user-1',
    })
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

  // crm#1272: start_sie_import_job names a hand-booked IB in the target year
  // the same way, as its own code instead of "Existing SIE import".
  it('becomes SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE carrying the sentence that names the verifikat', () => {
    const ib = 'Räkenskapsåret 2026-01-01 till 2026-12-31 har redan en bokförd ingående balans (verifikation A1, 2026-01-01), ' +
      'och importen skulle bokföra filens ingående balans en gång till.'
    const error = jobDatabaseError({ code: '55000', message: `SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE: ${ib}` })
    expect(error).toMatchObject({ code: 'SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE', pgCode: '55000', message: ib })
    expect(userFacingCode(error)).toBe('SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE')
  })

  it('keeps an existing import its own code', () => {
    const error = jobDatabaseError({ code: '55000', message: 'Existing SIE import requires reviewed replacement or reconciliation' })
    expect(error.code).toBe('SIE_IMPORT_PERIOD_ALREADY_IMPORTED')
    expect(userFacingCode(error)).toBeNull()
  })

  // 2026-11-16: SIE imports approved one after another while the first still
  // ran. As CONFLICT the import page said "En konflikt uppstod" and the
  // approval "Ett oväntat serverfel uppstod"; neither says what is in the way.
  it('names another unfinished import SIE_IMPORT_UNFINISHED, a 409 whose sentence says to wait, resume or undo it', async () => {
    const error = jobDatabaseError({ code: '55000', message: 'SIE import is unfinished: resume or undo it' })
    expect(error).toMatchObject({ code: 'SIE_IMPORT_UNFINISHED', pgCode: '55000' })
    const response = errorResponse(error, log as never, { requestId: 'req-1' })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('SIE_IMPORT_UNFINISHED')
    expect(body.error.message).toBe(
      'En annan SIE-import för företaget är inte klar än. Vänta tills den är klar, eller öppna den under ' +
      'Bokföring > Importera/Exportera > Importhistorik och tryck Fortsätt eller Ångra import. Starta sedan den här importen igen.')
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
