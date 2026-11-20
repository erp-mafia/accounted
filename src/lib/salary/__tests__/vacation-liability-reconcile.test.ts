/**
 * Stäm av semesterlöneskuld per datum and the method switch
 * (vacation-liability-reconcile.ts), and the remeasurement's own-voucher
 * exclusion that keeps a resumed run booking stable
 * (planVacationLiabilityRemeasure).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  checkPeriodLock: vi.fn(),
  postJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
  bookedVacationBalances: vi.fn(),
  generateBookedVacationSpec: vi.fn(),
  computeVacationLiability: vi.fn(),
  today: '2026-10-27',
}))

vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: mocks.checkPeriodLock }))
vi.mock('@/lib/posting/port', () => ({ postingPort: { postJournalEntry: mocks.postJournalEntry } }))
vi.mock('@/lib/bookkeeping/engine', () => ({ findFiscalPeriod: mocks.findFiscalPeriod }))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => mocks.today,
}))
vi.mock('@/lib/salary/semesterberedning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/semesterberedning')>()),
  bookedVacationBalances: mocks.bookedVacationBalances,
}))
vi.mock('@/lib/reports/vacation-liability', () => ({ generateBookedVacationSpec: mocks.generateBookedVacationSpec }))
vi.mock('@/lib/salary/vacation-liability-valuation', () => ({ computeVacationLiability: mocks.computeVacationLiability }))

import { reconcileVacationLiability, setVacationLiabilityMethod } from '../vacation-liability-reconcile'
import { planVacationLiabilityRemeasure } from '../vacation-liability-remeasure'

const COMPANY = 'company-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }

function valuationOf(liability: number, avgifter: number) {
  return {
    as_of_date: '2026-10-25',
    basis: 'calendar',
    vacation_year_start: '2026-01-01',
    day_value_policy: 'daily_divisor',
    settlement_year: 2026,
    rows: [
      {
        employee_id: 'emp-1',
        employee_name: 'Anna Andersson',
        vacation_rule: 'sammaloneregeln',
        liability_change_account: '7290',
        default_dimensions: null,
        days: { current_year_days: 10, saved_days: 0, earning_days: 0, unclosed_year_days: 0, total_days: 10 },
        day_value_sek: liability / 10,
        valued_days: 10,
        earning_sek: 0,
        day_value_basis: 'current_pay',
        variable_vacation_pay_sek: 0,
        computed_liability_sek: liability,
        avgifter_rate: 0.3142,
        computed_avgifter_sek: avgifter,
      },
    ],
    totals: { computed_liability: liability, computed_avgifter: avgifter },
  }
}

const SPEC_ROW = { employeeId: 'emp-1', employeeName: 'Anna Andersson', accruedAmount: 10000, accruedAvgifter: 3142, liabilityChangeAccount: '7290' }

let table: ReturnType<typeof createTableMockSupabase>
let ctx: { supabase: SupabaseClient; companyId: string; userId: string; log: never }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.today = '2026-10-27'
  table = createTableMockSupabase({
    company_settings: { data: { salary_vacation_liability_method: 'accrual' } },
    company_members: { data: { role: 'owner' } },
    vacation_liability_remeasurements: { data: null },
    journal_entries: { data: [] },
  })
  ctx = { supabase: table.supabase as unknown as SupabaseClient, companyId: COMPANY, userId: 'user-1', log: log as never }
  mocks.bookedVacationBalances.mockResolvedValue({ ok: true, data: { booked2920: 10000, booked2940: 3142 } })
  mocks.generateBookedVacationSpec.mockResolvedValue({ rows: [SPEC_ROW] })
  mocks.computeVacationLiability.mockImplementation(async (_s: unknown, _c: unknown, asOf: string) => ({
    ...valuationOf(14000, 4398.8),
    as_of_date: asOf,
  }))
  mocks.checkPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-2026' })
  mocks.findFiscalPeriod.mockResolvedValue('fp-2026')
  mocks.postJournalEntry.mockResolvedValue({ id: 'je-41', voucher_series: 'K', voucher_number: 41 })
})

describe('reconcileVacationLiability', () => {
  it('previews the difference as one verifikat and writes nothing', async () => {
    const outcome = await reconcileVacationLiability(ctx, { as_of: '2026-10-25' }, { dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({
      as_of: '2026-10-25',
      would_post: true,
      difference_2920: 4000,
      difference_2940: 1256.8,
      description: 'Semesterlöneskuld per 2026-10-25',
    })
    expect((outcome.preview.lines as unknown[]).length).toBe(4)
    expect(mocks.postJournalEntry).not.toHaveBeenCalled()
    expect(table.payloads('vacation_liability_remeasurements', 'insert')).toEqual([])
  })

  it('posts through the posting port dated the as-of date, and stores the calculation as the verifikat\'s underlag', async () => {
    const outcome = await reconcileVacationLiability(ctx, { as_of: '2026-10-25' }, { dryRun: false })
    expect(outcome).toMatchObject({
      ok: true,
      data: { adjusted: true, journal_entry_id: 'je-41', voucher_series: 'K', voucher_number: 41, difference_2920: 4000 },
    })
    const request = mocks.postJournalEntry.mock.calls[0][0]
    expect(request.input).toMatchObject({
      fiscal_period_id: 'fp-2026',
      entry_date: '2026-10-25',
      source_type: 'salary_payment',
      description: 'Semesterlöneskuld per 2026-10-25',
    })
    expect(request.input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2920', credit_amount: 4000 }),
    )
    // The event is the adjustment kind, dated the as-of date.
    expect(request.event()).toMatchObject({ kind: 'payroll.vacation_liability_adjusted', occurredOn: '2026-10-25' })
    const [row] = table.payloads('vacation_liability_remeasurements', 'insert') as Array<Record<string, unknown>>
    expect(row).toMatchObject({ company_id: COMPANY, as_of_date: '2026-10-25', kind: 'standalone', journal_entry_id: 'je-41' })
    expect(row.id).toBe(request.input.source_id)
  })

  it('refuses a locked period before anything posts', async () => {
    mocks.checkPeriodLock.mockResolvedValue({ locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-2025' })
    const outcome = await reconcileVacationLiability(ctx, { as_of: '2025-12-31' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'PERIOD_LOCKED', details: { entry_date: '2025-12-31' } })
    expect(mocks.postJournalEntry).not.toHaveBeenCalled()
  })

  it('hands the engine\'s own refusal (a lock set meanwhile) to the door', async () => {
    const engineError = new Error('Bokföringen är låst')
    mocks.postJournalEntry.mockRejectedValue(engineError)
    const outcome = await reconcileVacationLiability(ctx, { as_of: '2026-10-25' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, error: engineError })
    expect(table.payloads('vacation_liability_remeasurements', 'insert')).toEqual([])
  })

  it('refuses a date still ahead', async () => {
    const outcome = await reconcileVacationLiability(ctx, { as_of: '2026-10-31' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'VACATION_LIABILITY_DATE_AHEAD' })
    expect(mocks.computeVacationLiability).not.toHaveBeenCalled()
  })

  it('refuses a date no fiscal year covers', async () => {
    mocks.bookedVacationBalances.mockResolvedValue({ ok: false, code: 'VALIDATION_ERROR' })
    const outcome = await reconcileVacationLiability(ctx, { as_of: '2026-10-25' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'VACATION_LIABILITY_NO_FISCAL_PERIOD' })
  })

  it('books nothing when the books already hold the computed liability, so a repeat is harmless', async () => {
    mocks.computeVacationLiability.mockResolvedValue(valuationOf(10000, 3142))
    const outcome = await reconcileVacationLiability(ctx, { as_of: '2026-10-25' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { adjusted: false, journal_entry_id: null } })
    expect(mocks.checkPeriodLock).not.toHaveBeenCalled()
    expect(mocks.postJournalEntry).not.toHaveBeenCalled()
  })
})

describe('setVacationLiabilityMethod', () => {
  it('to remeasure: previews the catch-up as of today', async () => {
    const outcome = await setVacationLiabilityMethod(ctx, { method: 'remeasure' }, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { method: 'remeasure', previous_method: 'accrual', catch_up: { as_of: '2026-10-27', would_post: true } },
    })
    expect(table.payloads('company_settings', 'update')).toEqual([])
  })

  it('to remeasure: books the first catch-up, then switches', async () => {
    const outcome = await setVacationLiabilityMethod(ctx, { method: 'remeasure' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { method: 'remeasure', catch_up: { adjusted: true, journal_entry_id: 'je-41' } } })
    expect(table.payloads('vacation_liability_remeasurements', 'insert')[0]).toMatchObject({ kind: 'method_switch' })
    expect(table.payloads('company_settings', 'update')).toEqual([{ salary_vacation_liability_method: 'remeasure' }])
  })

  it('to remeasure in a locked period: refused, the method stays', async () => {
    mocks.checkPeriodLock.mockResolvedValue({ locked: true, reason: 'company_lock_date_covers' })
    const outcome = await setVacationLiabilityMethod(ctx, { method: 'remeasure' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'PERIOD_LOCKED' })
    expect(table.payloads('company_settings', 'update')).toEqual([])
  })

  it('back to accrual: only the setting changes', async () => {
    table.setTable('company_settings', { data: { salary_vacation_liability_method: 'remeasure' } })
    const outcome = await setVacationLiabilityMethod(ctx, { method: 'accrual' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { method: 'accrual', previous_method: 'remeasure', catch_up: null } })
    expect(mocks.postJournalEntry).not.toHaveBeenCalled()
    expect(table.payloads('company_settings', 'update')).toEqual([{ salary_vacation_liability_method: 'accrual' }])
  })
})

describe('planVacationLiabilityRemeasure: a resumed run booking computes the same lines', () => {
  it('leaves the run\'s own posted vouchers out of the booked balance it starts from', async () => {
    const first = await planVacationLiabilityRemeasure(ctx.supabase, COMPANY, '2026-10-25', { inFlightRunId: 'run-oct' })

    // The first attempt posted the vacation verifikat, then stopped: 2920 and
    // 2940 now include it.
    mocks.bookedVacationBalances.mockResolvedValue({ ok: true, data: { booked2920: 14000, booked2940: 4398.8 } })
    table.setTable('journal_entries', {
      data: [
        {
          entry_date: '2026-10-25',
          lines: [
            { account_number: '7290', debit_amount: 4000, credit_amount: 0 },
            { account_number: '2920', debit_amount: 0, credit_amount: 4000 },
            { account_number: '7519', debit_amount: 1256.8, credit_amount: 0 },
            { account_number: '2940', debit_amount: 0, credit_amount: 1256.8 },
          ],
        },
      ],
    })
    const resumed = await planVacationLiabilityRemeasure(ctx.supabase, COMPANY, '2026-10-25', { inFlightRunId: 'run-oct' })

    expect(first.ok && resumed.ok).toBe(true)
    if (!first.ok || !resumed.ok) return
    expect(resumed.data.lines).toEqual(first.data.lines)
    expect(resumed.data.booked_2920).toBe(10000)
    expect(table.findCall('journal_entries', 'eq')).toBeDefined()
  })
})
