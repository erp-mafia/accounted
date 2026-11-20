/**
 * PH 223: replacing an SIE import (a provider migration that imports a year
 * again, or a file import that replaces the year) refused with the generic
 * CONFLICT, "En konflikt uppstod. Ladda om sidan och försök igen.", when a
 * verifikat of the previous import had been corrected after it. A retry never
 * helps and nothing said which verifikat. The refusal now names each
 * imported verifikat with its live correction and says what to do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { findLiveCorrections, liveCorrectionSentence } from '../sie-live-corrections'
import { jobDatabaseError, nameLiveCorrections, requestSIEJobAction, SIEJobDatabaseError } from '../sie-jobs'
import { requestSIEImportAction } from '../sie-job-action-service'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { userFacingCode } from '@/lib/errors/user-facing'

const db = createQueuedMockSupabase()
const supabase = db.supabase as unknown as SupabaseClient
const LIVE = 'SIE undo requires review: an imported voucher has a live correction'

const entry = (id: string, series: string, number: number | null, correctionOf: string | null, importId: string | null) =>
  ({ id, voucher_series: series, voucher_number: number, correction_of_id: correctionOf, import_batch_id: importId })

// D980 corrected once (D1471). D990 corrected twice: D1472 was itself
// corrected by D1473, so only D1473 is live. A5 corrects a hand-booked A4
// and D20 belongs to the import itself: neither stops the import.
const live = [
  entry('c1', 'D', 1471, 'orig1', null),
  entry('c2b', 'D', 1473, 'c2a', null),
  entry('c3', 'A', 5, 'n1', null),
  entry('c4', 'D', 20, 'orig9', 'import-1'),
]
const parents = [entry('orig1', 'D', 980, null, 'import-1'), entry('c2a', 'D', 1472, 'orig2', null), entry('n1', 'A', 4, null, null)]
const grandparents = [entry('orig2', 'D', 990, null, 'import-1')]

describe('findLiveCorrections', () => {
  beforeEach(() => { vi.clearAllMocks(); db.reset() })

  it('names each imported verifikat with the live correction that descends from it, at any depth', async () => {
    db.enqueueMany([{ data: live }, { data: parents }, { data: grandparents }])
    expect(await findLiveCorrections(supabase, 'company-1', 'import-1')).toEqual([
      { original: 'D980', correction: 'D1471' },
      { original: 'D990', correction: 'D1473' },
    ])
    // Company scoped, live corrections only.
    expect(db.findCalls('journal_entries', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(db.findCall('journal_entries', 'in')).toEqual(['status', ['draft', 'posted']])
    expect(db.findCall('journal_entries', 'not')).toEqual(['correction_of_id', 'is', null])
  })

  it('reads nothing more when the company has no live correction outside the import', async () => {
    db.enqueue({ data: [entry('c4', 'D', 20, 'orig9', 'import-1')] })
    expect(await findLiveCorrections(supabase, 'company-1', 'import-1')).toEqual([])
    expect(db.supabase.from).toHaveBeenCalledOnce()
  })

  it('names a draft correction without a number', async () => {
    db.enqueueMany([{ data: [entry('c1', 'D', null, 'orig1', null)] }, { data: [parents[0]] }])
    expect(await findLiveCorrections(supabase, 'company-1', 'import-1')).toEqual([{ original: 'D980', correction: null }])
  })
})

describe('liveCorrectionSentence', () => {
  const two = [{ original: 'D980', correction: 'D1471' }, { original: 'D990', correction: 'D1473' }]

  it('says for a replacement what collides, why, and what to do', () => {
    const sentence = liveCorrectionSentence(two, 'replace')
    expect(sentence).toBe(
      'Den tidigare importen av räkenskapsåret kan inte ersättas: verifikat från importen har rättats efter importen ' +
      '(D980 med rättelse D1471, D990 med rättelse D1473). Rättelserna skulle ligga kvar och räknas dubbelt bredvid den nya importen. ' +
      'Återför rättelserna först (öppna verifikationen under Bokföring > Verifikationer och välj Återför (storno)), ' +
      'och importera sedan året igen. Vill du behålla rättelserna, behåll den tidigare importen av året.')
    expect(sentence).not.toMatch(/[\u2013\u2014]/)
  })

  it('words an undo as an undo', () => {
    expect(liveCorrectionSentence(two, 'undo')).toMatch(/^Importen kan inte ångras: .* och ångra sedan importen\.$/)
  })

  it('names five and counts the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ original: `D${i + 1}`, correction: `D${i + 101}` }))
    const sentence = liveCorrectionSentence(many, 'replace')
    expect(sentence).toContain('D5 med rättelse D105 och 3 till)')
    expect(sentence).not.toContain('D6 med')
  })

  it('names a draft correction as a draft', () => {
    expect(liveCorrectionSentence([{ original: 'D980', correction: null }], 'undo'))
      .toContain('(D980 med en rättelse som är ett utkast)')
  })
})

describe('the live-correction refusal', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  beforeEach(() => { vi.clearAllMocks(); db.reset() })

  it('gets its own code instead of CONFLICT', () => {
    const error = jobDatabaseError({ code: '55000', message: LIVE })
    expect(error).toMatchObject({ code: 'SIE_IMPORT_HAS_LIVE_CORRECTION', pgCode: '55000' })
    // Without names the registry's Swedish sentence answers, never the raw one.
    expect(userFacingCode(error)).toBeNull()
  })

  it('leaves every other refusal as it came, without a read', async () => {
    const error = jobDatabaseError({ code: '55000', message: 'Another SIE execution must finish before undo' })
    expect(await nameLiveCorrections(error, supabase, 'company-1', 'import-1', 'undo')).toBe(error)
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('keeps the code and the static sentence when the read fails', async () => {
    db.enqueue({ error: { code: '57014', message: 'statement timeout' } })
    const error = jobDatabaseError({ code: '55000', message: LIVE })
    const named = await nameLiveCorrections(error, supabase, 'company-1', 'import-1', 'replace')
    expect(named).toBe(error)
    const body = await errorResponse(named, log as never, { requestId: 'req-1' }).json()
    expect(body.error.code).toBe('SIE_IMPORT_HAS_LIVE_CORRECTION')
    expect(getErrorMessage(body)).toContain('Återför rättelserna först')
  })

  it('keeps the code without the import id (a first import, not a replacement)', async () => {
    const error = jobDatabaseError({ code: '55000', message: LIVE })
    expect(await nameLiveCorrections(error, supabase, 'company-1', undefined, 'replace')).toBe(error)
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('answers a refused undo with a 409 that names the verifikat', async () => {
    db.enqueueMany([
      { data: { id: 'import-1', job_state: 'completed' } },
      { error: { code: '55000', message: LIVE } },
      { data: live }, { data: parents }, { data: grandparents },
    ])
    const error = await requestSIEJobAction(supabase, 'company-1', 'user-1', 'import-1', 'undo').catch(value => value)
    expect(error).toBeInstanceOf(SIEJobDatabaseError)
    expect(userFacingCode(error)).toBe('SIE_IMPORT_HAS_LIVE_CORRECTION')
    const response = errorResponse(error, log as never, { requestId: 'req-1' })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('SIE_IMPORT_HAS_LIVE_CORRECTION')
    expect(getErrorMessage(body)).toBe(liveCorrectionSentence([
      { original: 'D980', correction: 'D1471' }, { original: 'D990', correction: 'D1473' }], 'undo'))
  })
})

// The undo operation (v1 imports.sie.undo, the staged gnubok_undo_sie_import)
// keeps its documented code and carries the named sentence.
describe('requestSIEImportAction: live correction', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = () => ({ supabase, companyId: 'company-1', userId: 'user-1', log: log as never })
  const row = { id: 'import-1', job_state: 'completed', job_kind: 'import', job_phase: 'finalize', user_id: 'user-1',
    execution_actor_id: null, fiscal_period_id: 'fp-1', filename: 'f.se', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31' }

  beforeEach(() => { vi.clearAllMocks(); db.reset() })

  it('answers SIE_IMPORT_ACTION_CONFLICT with the sentence that names the verifikat', async () => {
    db.enqueueMany([
      { data: row }, // sie_imports lookup
      { data: { role: 'owner' } }, // company_members: owner/admin gate
      { data: { id: 'import-1', job_state: 'completed' } }, // requestSIEJobAction preflight
      { error: { code: '55000', message: LIVE } }, // request_sie_import_undo refuses
      { data: live }, { data: parents }, { data: grandparents },
    ])
    const outcome = await requestSIEImportAction(ctx(), 'import-1', 'undo')
    expect(outcome).toEqual({
      ok: false,
      code: 'SIE_IMPORT_ACTION_CONFLICT',
      messageSv: liveCorrectionSentence([
        { original: 'D980', correction: 'D1471' }, { original: 'D990', correction: 'D1473' }], 'undo'),
      details: { reason: LIVE },
    })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('keeps the registry sentence when the verifikat cannot be named', async () => {
    db.enqueueMany([
      { data: row }, { data: { role: 'owner' } }, { data: { id: 'import-1', job_state: 'completed' } },
      { error: { code: '55000', message: LIVE } },
      { error: { code: '57014', message: 'statement timeout' } },
    ])
    expect(await requestSIEImportAction(ctx(), 'import-1', 'undo'))
      .toEqual({ ok: false, code: 'SIE_IMPORT_ACTION_CONFLICT', details: { reason: LIVE } })
  })
})
