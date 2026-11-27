/**
 * A storno of a booked salary run's verifikat: refused before the storno
 * (Korrigera lönekörning is the way, and its own stornos pass the
 * salaryRunCorrection option, tested with the hook list); a voucher of a run
 * that is not booked, one the run does not point at, and a salary_payment
 * verifikat that names no run pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { BookedSalaryRunStornoError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { assertSalaryRunVerifikatReversible } from '../run-verifikat-reversal'

const COMPANY = 'company-1'

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    company_id: COMPANY,
    status: 'booked',
    salary_entry_id: 'je-salary',
    avgifter_entry_id: 'je-avgifter',
    vacation_entry_id: 'je-vacation',
    pension_entry_id: null,
    ...overrides,
  }
}

const voucher = (id: string, sourceId: string | null = 'run-1') => ({ id, source_id: sourceId })

beforeEach(() => vi.clearAllMocks())

describe('assertSalaryRunVerifikatReversible', () => {
  it.each(['je-salary', 'je-avgifter', 'je-vacation'])('refuses %s of a booked run', async (entryId) => {
    const { supabase } = createRowsMockSupabase({ salary_runs: [run()] })
    const refusal = assertSalaryRunVerifikatReversible(supabase as never, COMPANY, voucher(entryId))
    await expect(refusal).rejects.toBeInstanceOf(BookedSalaryRunStornoError)
    await expect(refusal).rejects.toMatchObject({ code: 'SALARY_RUN_STORNO_BOOKED', salaryRunId: 'run-1' })
  })

  it.each(['paid', 'approved', 'corrected'])('lets a voucher of a %s run through', async (status) => {
    // paid: a booking that stopped partway asks for its stray vouchers to be
    // reversed (SalaryRunPartiallyBookedError) before it books again.
    const { supabase } = createRowsMockSupabase({ salary_runs: [run({ status })] })
    await expect(assertSalaryRunVerifikatReversible(supabase as never, COMPANY, voucher('je-salary'))).resolves.toBeUndefined()
  })

  it('lets a voucher of a booked run through that the run does not point at', async () => {
    const { supabase } = createRowsMockSupabase({ salary_runs: [run()] })
    await expect(assertSalaryRunVerifikatReversible(supabase as never, COMPANY, voucher('je-stray'))).resolves.toBeUndefined()
  })

  it('lets a salary_payment verifikat through that names no run (semesterår, semesterlöneskuld)', async () => {
    const { supabase, tables } = createRowsMockSupabase({ salary_runs: [run()] })
    await expect(
      assertSalaryRunVerifikatReversible(supabase as never, COMPANY, voucher('je-closure', 'closure-1')),
    ).resolves.toBeUndefined()
    await expect(assertSalaryRunVerifikatReversible(supabase as never, COMPANY, voucher('je-none', null))).resolves.toBeUndefined()
    // Without a source_id nothing is read.
    expect(tables()).toEqual(['salary_runs'])
  })

  it('reads company-scoped, by the run id the voucher names', async () => {
    const { supabase, findCalls } = createRowsMockSupabase({ salary_runs: [] })
    await assertSalaryRunVerifikatReversible(supabase as never, COMPANY, voucher('je-salary'))
    expect(findCalls('salary_runs', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['id', 'run-1'],
    ])
  })

  it('throws on a failed read: unknown is never reversible', async () => {
    const { supabase } = createTableMockSupabase({ salary_runs: { data: null, error: { message: 'boom' } } })
    await expect(assertSalaryRunVerifikatReversible(supabase as never, COMPANY, voucher('je-salary'))).rejects.toThrow(
      /run lookup failed/,
    )
  })

  it('names Korrigera lönekörning in the Swedish refusal and Correct payroll run in the English one', () => {
    const refusal = new BookedSalaryRunStornoError('run-1')
    expect(getErrorMessage(refusal)).toMatch(/Korrigera lönekörning/)
    expect(getErrorMessage(refusal, { locale: 'en' })).toMatch(/Correct payroll run/)
  })
})
