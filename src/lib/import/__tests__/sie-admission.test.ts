/**
 * checkSIEImportAdmission (crm#1272): the year the import would use, then
 * the database's own admission rule for it, read-only. The rule itself
 * (sie_import_admission_refusal) is pinned against real Postgres in
 * tests/pg/sie-import-admission-refusal.pg.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { checkSIEImportAdmission, NO_MATCHING_FISCAL_YEAR } from '../sie-admission'

const YEAR = { start: '2026-01-01', end: '2026-12-31' }
const OPEN_2026 = {
  id: 'fp-2026', name: 'Räkenskapsår 2026', period_start: '2026-01-01', period_end: '2026-12-31',
  is_closed: false, locked_at: null, closed_externally: false, closing_entry_id: null,
}

describe('checkSIEImportAdmission', () => {
  it('reads the rule for the existing year with the import\'s IB option', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: OPEN_2026 },
      {
        data: {
          reason: 'opening_balance', entry_id: 'je-ib', voucher: 'A1', entry_date: '2026-01-01',
          message: 'Räkenskapsåret 2026 har redan en bokförd ingående balans (verifikation A1, 2026-01-01).',
        },
      },
    ])

    const admission = await checkSIEImportAdmission(supabase as never, 'company-1', YEAR, { importOpeningBalances: true })

    expect(supabase.rpc).toHaveBeenCalledWith('sie_import_admission_refusal', {
      p_company_id: 'company-1',
      p_period_id: 'fp-2026',
      p_period_start: '2026-01-01',
      p_period_end: '2026-12-31',
      p_supersedes_import_id: null,
      p_import_opening_balances: true,
    })
    expect(admission).toEqual({
      fiscalYear: { verdict: 'match', periodId: 'fp-2026' },
      refusal: {
        reason: 'opening_balance', entryId: 'je-ib', voucher: 'A1', entryDate: '2026-01-01',
        message: 'Räkenskapsåret 2026 har redan en bokförd ingående balans (verifikation A1, 2026-01-01).',
      },
    })
  })

  it('admits when the rule answers nothing', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: OPEN_2026 }, { data: null }])

    const admission = await checkSIEImportAdmission(supabase as never, 'company-1', YEAR, { importOpeningBalances: false })

    expect(admission.refusal).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledWith('sie_import_admission_refusal',
      expect.objectContaining({ p_import_opening_balances: false }))
  })

  it('checks a year the import would create by the file\'s dates', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null }, // no year contains the file
      { data: [] }, // none overlaps it
      { data: { reason: 'existing_import', import_id: 'imp-1' } },
    ])

    const admission = await checkSIEImportAdmission(supabase as never, 'company-1', YEAR, { importOpeningBalances: true })

    expect(supabase.rpc).toHaveBeenCalledWith('sie_import_admission_refusal',
      expect.objectContaining({ p_period_id: null, p_period_start: '2026-01-01', p_period_end: '2026-12-31' }))
    expect(admission).toEqual({
      fiscalYear: { verdict: 'create', replacesEmptyPeriodId: null },
      refusal: { reason: 'existing_import', importId: 'imp-1' },
    })
  })

  it('refuses a missing year when the import may not create one, as submitSIEJob does', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: null }, { data: [] }])

    const admission = await checkSIEImportAdmission(supabase as never, 'company-1', YEAR,
      { importOpeningBalances: true, createFiscalPeriod: false })

    expect(admission).toEqual({ fiscalYear: { verdict: 'invalid', message: NO_MATCHING_FISCAL_YEAR }, refusal: null })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('answers a closed year with the fiscal-year refusal and reads no rule', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: { ...OPEN_2026, locked_at: '2026-10-01T00:00:00Z' } }])

    const admission = await checkSIEImportAdmission(supabase as never, 'company-1', YEAR, { importOpeningBalances: true })

    expect(admission.fiscalYear.verdict).toBe('conflict')
    expect(admission.refusal).toBeNull()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('names an unfinished import', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: OPEN_2026 }, { data: { reason: 'unfinished_import', import_id: 'imp-running' } }])

    const admission = await checkSIEImportAdmission(supabase as never, 'company-1', YEAR, { importOpeningBalances: true })

    expect(admission.refusal).toEqual({ reason: 'unfinished_import', importId: 'imp-running' })
  })

  it('treats a reason it does not know as a refusal, never as ok', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: OPEN_2026 }, { data: { reason: 'something_new' } }])

    const admission = await checkSIEImportAdmission(supabase as never, 'company-1', YEAR, { importOpeningBalances: true })

    expect(admission.refusal).not.toBeNull()
  })

  it('throws when the rule cannot be read instead of answering ok', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: OPEN_2026 }, { error: { message: 'permission denied' } }])

    await expect(
      checkSIEImportAdmission(supabase as never, 'company-1', YEAR, { importOpeningBalances: true }),
    ).rejects.toThrow(/permission denied/)
  })
})
