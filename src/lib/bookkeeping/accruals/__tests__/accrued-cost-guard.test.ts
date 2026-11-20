import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assertAccruedCostLinesBookable,
  assertAccruedIncomeLinesBookable,
} from '@/lib/bookkeeping/accruals/accrued-cost-guard'
import { checkPeriodLock, type PeriodLockVerdict } from '@/lib/api/v1/check-period-lock'
import {
  AccruedCostPeriodInvalidError,
  AccruedCostPeriodLockedError,
  AccruedIncomePeriodInvalidError,
  AccruedIncomePeriodLockedError,
  DeferralPeriodPastError,
  INVOICE_ACCRUED_INCOME_PERIOD_LOCKED,
  SI_ACCRUED_COST_PERIOD_LOCKED,
  isBookkeepingError,
} from '@/lib/bookkeeping/errors'
import { classifyError } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'

vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn(),
}))

const mockCheckPeriodLock = vi.mocked(checkPeriodLock)
const supabase = {} as SupabaseClient
const COMPANY = 'company-1'

const open: PeriodLockVerdict = { locked: false, fiscal_period_id: 'fp-1' }

const accruedLine = (start: string, end: string, account = '2990') => ({
  accrual_period_start: start,
  accrual_period_end: end,
  accrual_balance_account: account,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckPeriodLock.mockResolvedValue(open)
})

describe('assertAccruedCostLinesBookable', () => {
  it('reads nothing when no line is an upplupen kostnad', async () => {
    await assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-05', [
      accruedLine('2026-10-01', '2027-09-30', '1730'),
      { accrual_period_start: null, accrual_period_end: null, accrual_balance_account: null },
    ])
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
  })

  it('checks every month-end of a multi-month period (Jul-Sep on an October invoice)', async () => {
    await assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-05', [
      accruedLine('2026-07-01', '2026-09-30'),
    ])
    expect(mockCheckPeriodLock.mock.calls.map((call) => call[2])).toEqual([
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
    ])
  })

  it('checks a December month-end in the previous fiscal year (January invoice)', async () => {
    await assertAccruedCostLinesBookable(supabase, COMPANY, '2026-01-20', [
      accruedLine('2025-11-01', '2025-12-31'),
    ])
    expect(mockCheckPeriodLock.mock.calls.map((call) => call[2])).toEqual(['2025-11-30', '2025-12-31'])
  })

  it('refuses a period that reaches the invoice month, before any lookup', async () => {
    const attempt = assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-05', [
      accruedLine('2026-09-01', '2026-10-31'),
    ])
    await expect(attempt).rejects.toBeInstanceOf(AccruedCostPeriodInvalidError)
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
  })

  it('refuses the whole registration when one month is locked, naming it', async () => {
    mockCheckPeriodLock.mockImplementation(async (_s, _c, date) =>
      date === '2026-08-31' ? { locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-1' } : open,
    )
    const attempt = assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-05', [
      accruedLine('2026-07-01', '2026-09-30'),
    ])
    await expect(attempt).rejects.toMatchObject({
      code: SI_ACCRUED_COST_PERIOD_LOCKED,
      blocked: [{ date: '2026-08-31', reason: 'period_locked_at_set' }],
    })
  })

  it('refuses a month behind the company lock date, a closed year and a missing year', async () => {
    mockCheckPeriodLock.mockImplementation(async (_s, _c, date) => {
      if (date === '2025-11-30') return { locked: true, reason: 'period_is_closed' }
      if (date === '2025-12-31') return { locked: true, reason: 'company_lock_date_covers' }
      return open
    })
    await expect(
      assertAccruedCostLinesBookable(supabase, COMPANY, '2026-01-20', [accruedLine('2025-11-01', '2025-12-31')]),
    ).rejects.toMatchObject({
      blocked: [
        { date: '2025-11-30', reason: 'period_is_closed' },
        { date: '2025-12-31', reason: 'company_lock_date_covers' },
      ],
    })

    // checkPeriodLock answers "open" without a fiscal year; the release
    // service cannot post there, so it blocks too.
    mockCheckPeriodLock.mockResolvedValue({ locked: false, reason: 'no_fiscal_period' })
    await expect(
      assertAccruedCostLinesBookable(supabase, COMPANY, '2026-01-20', [accruedLine('2025-12-01', '2025-12-31')]),
    ).rejects.toMatchObject({ blocked: [{ date: '2025-12-31', reason: 'no_fiscal_period' }] })
  })

  it('fails closed when the lock lookup fails', async () => {
    mockCheckPeriodLock.mockResolvedValue({ locked: true, reason: 'lookup_failed' })
    await expect(
      assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-05', [accruedLine('2026-09-01', '2026-09-30')]),
    ).rejects.toMatchObject({ blocked: [{ date: '2026-09-30', reason: 'lookup_failed' }] })
  })

  it('checks a month-end shared by two lines once', async () => {
    await assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-05', [
      accruedLine('2026-08-01', '2026-09-30'),
      accruedLine('2026-09-01', '2026-09-30', '2960'),
    ])
    expect(mockCheckPeriodLock.mock.calls.map((call) => call[2])).toEqual(['2026-08-31', '2026-09-30'])
  })
})

describe('the refusal as a structured error', () => {
  it('is a typed bookkeeping error with the blocked dates as details', () => {
    const err = new AccruedCostPeriodLockedError([{ date: '2026-09-30', reason: 'period_locked_at_set' }])
    expect(isBookkeepingError(err)).toBe(true)
    expect(classifyError(err)).toMatchObject({
      code: 'SI_ACCRUED_COST_PERIOD_LOCKED',
      details: { blocked: [{ date: '2026-09-30', reason: 'period_locked_at_set' }] },
    })
  })

  it('reads as Swedish naming each month-end and why', () => {
    const message = getErrorMessage({
      error: {
        code: 'SI_ACCRUED_COST_PERIOD_LOCKED',
        message: 'An accrued cost (29xx) would post on 2026-09-30 (period_locked_at_set)',
        details: {
          blocked: [
            { date: '2026-08-31', reason: 'company_lock_date_covers' },
            { date: '2026-09-30', reason: 'period_locked_at_set' },
          ],
        },
      },
    })
    expect(message).toContain('2026-08-31 (inom företagets låsdatum)')
    expect(message).toContain('2026-09-30 (perioden är låst)')
    expect(message).toMatch(/flyttas inte till en annan månad/)
  })

  it('names the invalid period code too', () => {
    const err = new AccruedCostPeriodInvalidError('2026-09-01', '2026-10-31', '2026-10-05')
    expect(classifyError(err)).toMatchObject({
      code: 'SI_ACCRUED_COST_PERIOD_INVALID',
      details: { periodStart: '2026-09-01', periodEnd: '2026-10-31', invoiceDate: '2026-10-05' },
    })
    expect(getErrorMessage({ error: { code: 'SI_ACCRUED_COST_PERIOD_INVALID', message: err.message } })).toMatch(
      /dela raden/i,
    )
  })
})

// Upplupen intäkt (17xx, #62): September consulting on an October invoice.
describe('assertAccruedIncomeLinesBookable', () => {
  it('reads nothing when no line is an upplupen intäkt (a 29xx deferral, no periodisering)', async () => {
    await assertAccruedIncomeLinesBookable(supabase, COMPANY, '2026-10-15', [
      accruedLine('2026-11-01', '2027-04-30', '2970'),
      { accrual_period_start: null, accrual_period_end: null, accrual_balance_account: null },
    ])
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
  })

  it('checks every month-end of the period before the invoice month', async () => {
    await assertAccruedIncomeLinesBookable(supabase, COMPANY, '2026-10-15', [
      accruedLine('2026-08-01', '2026-09-30', '1790'),
    ])
    expect(mockCheckPeriodLock.mock.calls.map((call) => call[2])).toEqual(['2026-08-31', '2026-09-30'])
  })

  it('refuses a period that reaches the invoice month, before any lookup', async () => {
    const attempt = assertAccruedIncomeLinesBookable(supabase, COMPANY, '2026-10-15', [
      accruedLine('2026-09-01', '2026-10-31', '1790'),
    ])
    await expect(attempt).rejects.toBeInstanceOf(AccruedIncomePeriodInvalidError)
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
  })

  it('refuses the whole booking when a month is locked or behind the lock date, naming each', async () => {
    mockCheckPeriodLock.mockImplementation(async (_s, _c, date) =>
      date === '2026-08-31' ? { locked: true, reason: 'company_lock_date_covers' } : open,
    )
    await expect(
      assertAccruedIncomeLinesBookable(supabase, COMPANY, '2026-10-15', [accruedLine('2026-08-01', '2026-09-30', '1780')]),
    ).rejects.toMatchObject({
      code: INVOICE_ACCRUED_INCOME_PERIOD_LOCKED,
      blocked: [{ date: '2026-08-31', reason: 'company_lock_date_covers' }],
    })
  })

  it('blocks a month-end no fiscal year covers', async () => {
    mockCheckPeriodLock.mockResolvedValue({ locked: false, reason: 'no_fiscal_period' })
    await expect(
      assertAccruedIncomeLinesBookable(supabase, COMPANY, '2026-01-20', [accruedLine('2025-12-01', '2025-12-31', '1790')]),
    ).rejects.toBeInstanceOf(AccruedIncomePeriodLockedError)
  })

  it('leaves a 29xx upplupen kostnad to the supplier guard', async () => {
    await assertAccruedIncomeLinesBookable(supabase, COMPANY, '2026-10-15', [
      accruedLine('2026-09-01', '2026-10-31', '2990'),
    ])
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
  })
})

describe('the accrued income refusal as a structured error', () => {
  it('is a typed bookkeeping error with the blocked dates, read as Swedish', () => {
    const err = new AccruedIncomePeriodLockedError([{ date: '2026-09-30', reason: 'period_locked_at_set' }])
    expect(isBookkeepingError(err)).toBe(true)
    expect(classifyError(err)).toMatchObject({
      code: 'INVOICE_ACCRUED_INCOME_PERIOD_LOCKED',
      details: { blocked: [{ date: '2026-09-30', reason: 'period_locked_at_set' }] },
    })
    const message = getErrorMessage({
      error: { code: 'INVOICE_ACCRUED_INCOME_PERIOD_LOCKED', message: err.message, details: { blocked: err.blocked } },
    })
    expect(message).toContain('En upplupen intäkt')
    expect(message).toContain('2026-09-30 (perioden är låst)')
    expect(message).toMatch(/Intäkten flyttas inte till en annan månad/)
  })

  it('names the invalid period code too', () => {
    const err = new AccruedIncomePeriodInvalidError('2026-09-01', '2026-10-31', '2026-10-15')
    expect(isBookkeepingError(err)).toBe(true)
    expect(classifyError(err)).toMatchObject({
      code: 'INVOICE_ACCRUED_INCOME_PERIOD_INVALID',
      details: { periodStart: '2026-09-01', periodEnd: '2026-10-31', invoiceDate: '2026-10-15' },
    })
    expect(getErrorMessage({ error: { code: 'INVOICE_ACCRUED_INCOME_PERIOD_INVALID', message: err.message } })).toMatch(
      /dela raden/i,
    )
  })
})

// accounted#113: the opposite mistake, a deferral of months that are over.
describe('a deferral of months before the invoice month', () => {
  it('refuses a 17xx cost period that ended before the invoice month, naming 2990, before any lookup', async () => {
    const attempt = assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-08', [
      { ...accruedLine('2026-08-01', '2026-09-30', '1790'), account_number: '6540' },
    ])
    await expect(attempt).rejects.toBeInstanceOf(DeferralPeriodPastError)
    await expect(attempt).rejects.toMatchObject({
      code: 'SI_PREPAID_COST_PERIOD_PAST',
      balanceAccount: '1790',
      suggestedAccount: '2990',
    })
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
  })

  it('names 2960 for a räntekostnad (84xx)', async () => {
    await expect(
      assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-08', [
        { ...accruedLine('2026-07-01', '2026-09-30', '1740'), account_number: '8410' },
      ]),
    ).rejects.toMatchObject({ suggestedAccount: '2960' })
  })

  it('refuses a line without an account too: the booking would fall back to a 17xx deferral', async () => {
    await expect(
      assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-08', [
        { ...accruedLine('2026-08-01', '2026-09-30'), accrual_balance_account: null, account_number: '5020' },
      ]),
    ).rejects.toMatchObject({ code: 'SI_PREPAID_COST_PERIOD_PAST', balanceAccount: null, suggestedAccount: '2990' })
  })

  it('refuses a 29xx revenue period that ended before the invoice month, naming 1790', async () => {
    const attempt = assertAccruedIncomeLinesBookable(supabase, COMPANY, '2026-10-26', [
      accruedLine('2026-09-01', '2026-09-30', '2970'),
    ])
    await expect(attempt).rejects.toMatchObject({
      code: 'INVOICE_DEFERRED_INCOME_PERIOD_PAST',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      invoiceDate: '2026-10-26',
      suggestedAccount: '1790',
    })
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
  })

  it('keeps a deferral that overlaps the invoice month (Sep-Nov on an October invoice)', async () => {
    await assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-08', [accruedLine('2026-09-01', '2026-11-30', '1790')])
    await assertAccruedIncomeLinesBookable(supabase, COMPANY, '2026-10-26', [accruedLine('2026-09-01', '2026-11-30', '2970')])
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
  })

  it('keeps a deferral after the invoice month', async () => {
    await assertAccruedCostLinesBookable(supabase, COMPANY, '2026-10-08', [accruedLine('2026-11-01', '2027-10-31', '1730')])
    await assertAccruedIncomeLinesBookable(supabase, COMPANY, '2026-10-26', [accruedLine('2026-11-01', '2027-04-30', '2970')])
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
  })

  it('is a typed bookkeeping error whose Swedish message names the right account', () => {
    const cost = new DeferralPeriodPastError('expense', '2026-08-01', '2026-09-30', '2026-10-08', '1790', '2990')
    expect(isBookkeepingError(cost)).toBe(true)
    expect(classifyError(cost)).toMatchObject({
      code: 'SI_PREPAID_COST_PERIOD_PAST',
      details: { periodEnd: '2026-09-30', invoiceDate: '2026-10-08', balanceAccount: '1790', suggestedAccount: '2990' },
    })
    expect(getErrorMessage({ error: { code: 'SI_PREPAID_COST_PERIOD_PAST', message: cost.message } })).toMatch(
      /upplupen kostnad.*2990/,
    )

    const income = new DeferralPeriodPastError('revenue', '2026-09-01', '2026-09-30', '2026-10-26', '2970', '1790')
    expect(classifyError(income)).toMatchObject({ code: 'INVOICE_DEFERRED_INCOME_PERIOD_PAST' })
    expect(getErrorMessage({ error: { code: 'INVOICE_DEFERRED_INCOME_PERIOD_PAST', message: income.message } })).toMatch(
      /upplupen intäkt.*1790/,
    )
  })
})
