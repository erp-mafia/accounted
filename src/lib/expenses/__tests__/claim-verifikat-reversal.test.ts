/**
 * A storno of an expense claim's verifikat: refused before the storno while
 * the claim stands. The refusal names what works for the claim, as Ta bort
 * (deleteExpenseClaim) answers it: Ta bort for a registered claim on no
 * payslip or on a draft run's, Rätta for a claim paid out or on the payslip
 * of a run past draft (Ta bort refuses both). Ta bort's own storno passes the
 * expenseClaimRemoval option, tested with the hook list. A verifikat no claim
 * points at passes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { PaidExpenseClaimStornoError, RegisteredExpenseClaimStornoError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { assertExpenseClaimVerifikatReversible } from '../claim-verifikat-reversal'

const COMPANY = 'company-1'

function claim(overrides: Record<string, unknown> = {}) {
  return { id: 'claim-1', company_id: COMPANY, journal_entry_id: 'je-claim', status: 'registered', ...overrides }
}

function payslipLine(runStatus: string) {
  return {
    id: 'line-1',
    company_id: COMPANY,
    source_expense_claim_id: 'claim-1',
    salary_run_employee: {
      salary_run: { id: 'run-1', status: runStatus, period_year: 2026, period_month: 11, payment_date: '2026-11-25' },
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('assertExpenseClaimVerifikatReversible', () => {
  it('refuses the verifikat of a registered claim on no payslip, naming Ta bort', async () => {
    const { supabase } = createRowsMockSupabase({ expense_claims: [claim()], salary_line_items: [] })
    const refusal = assertExpenseClaimVerifikatReversible(supabase as never, COMPANY, 'je-claim')
    await expect(refusal).rejects.toBeInstanceOf(RegisteredExpenseClaimStornoError)
    await expect(refusal).rejects.toMatchObject({ code: 'EXPENSE_CLAIM_STORNO_REGISTERED', expenseClaimId: 'claim-1' })
  })

  it('refuses the verifikat of a registered claim on a draft run\'s payslip, naming Ta bort (it takes the line off)', async () => {
    const { supabase } = createRowsMockSupabase({ expense_claims: [claim()], salary_line_items: [payslipLine('draft')] })
    await expect(assertExpenseClaimVerifikatReversible(supabase as never, COMPANY, 'je-claim')).rejects.toBeInstanceOf(
      RegisteredExpenseClaimStornoError,
    )
  })

  it.each(['review', 'approved', 'paid', 'booked'])(
    'refuses the verifikat of a claim on the payslip of a %s run, naming Rätta (Ta bort refuses it)',
    async (runStatus) => {
      const { supabase } = createRowsMockSupabase({ expense_claims: [claim()], salary_line_items: [payslipLine(runStatus)] })
      const refusal = assertExpenseClaimVerifikatReversible(supabase as never, COMPANY, 'je-claim')
      await expect(refusal).rejects.toBeInstanceOf(PaidExpenseClaimStornoError)
      await expect(refusal).rejects.toMatchObject({ code: 'EXPENSE_CLAIM_STORNO_PAID', expenseClaimId: 'claim-1' })
    },
  )

  it('refuses the verifikat of a paid claim, naming Rätta, without reading payslips', async () => {
    const { supabase, tables } = createRowsMockSupabase({ expense_claims: [claim({ status: 'paid' })], salary_line_items: [] })
    await expect(assertExpenseClaimVerifikatReversible(supabase as never, COMPANY, 'je-claim')).rejects.toBeInstanceOf(
      PaidExpenseClaimStornoError,
    )
    expect(tables()).toEqual(['expense_claims'])
  })

  it('lets a verifikat no claim points at through (a removed claim, a claim pointing at its correction)', async () => {
    const { supabase, tables } = createRowsMockSupabase({
      expense_claims: [claim({ journal_entry_id: 'je-correction' })],
      salary_line_items: [],
    })
    await expect(assertExpenseClaimVerifikatReversible(supabase as never, COMPANY, 'je-claim')).resolves.toBeUndefined()
    expect(tables()).toEqual(['expense_claims'])
  })

  it('reads company-scoped, by the claim pointer, and the payslip line through the one reader', async () => {
    const { supabase, findCalls } = createRowsMockSupabase({ expense_claims: [claim()], salary_line_items: [] })
    await assertExpenseClaimVerifikatReversible(supabase as never, COMPANY, 'je-claim').catch(() => undefined)
    expect(findCalls('expense_claims', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['journal_entry_id', 'je-claim'],
    ])
    expect(findCalls('salary_line_items', 'eq')).toEqual([['company_id', COMPANY]])
    expect(findCalls('salary_line_items', 'in')).toEqual([['source_expense_claim_id', ['claim-1']]])
  })

  it('throws on a failed read: unknown is never reversible', async () => {
    const failedClaims = createTableMockSupabase({ expense_claims: { data: null, error: { message: 'boom' } } })
    await expect(
      assertExpenseClaimVerifikatReversible(failedClaims.supabase as never, COMPANY, 'je-claim'),
    ).rejects.toThrow(/lookup by voucher failed/)

    const failedLines = createTableMockSupabase({
      expense_claims: { data: [claim()] },
      salary_line_items: { data: null, error: { message: 'boom' } },
    })
    await expect(
      assertExpenseClaimVerifikatReversible(failedLines.supabase as never, COMPANY, 'je-claim'),
    ).rejects.toThrow(/payslip lines/)
  })

  it('names Ta bort for a registered claim and Rätta for a paid one, in Swedish and in English', () => {
    const registered = new RegisteredExpenseClaimStornoError('claim-1')
    expect(getErrorMessage(registered)).toMatch(/Ta bort utlägget i stället/)
    expect(getErrorMessage(registered, { locale: 'en' })).toMatch(/Delete the claim instead/)

    const paid = new PaidExpenseClaimStornoError('claim-1')
    expect(getErrorMessage(paid)).toMatch(/rätta verifikationen \(Rätta\)/)
    expect(getErrorMessage(paid)).not.toMatch(/Ta bort/)
    expect(getErrorMessage(paid, { locale: 'en' })).toMatch(/correct the voucher/)
  })
})
