import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assertNoDeviationOverlap,
  defaultDeviationWindow,
  hasCustomDeviationWindow,
  monthWindow,
  previousMonth,
  resolveDeviationWindowForNewRun,
  runDeviationWindow,
  SalaryDeviationPeriodError,
  validateExplicitWindow,
} from '../deviation-period'

/** Minimal thenable query chain: every builder method returns the chain,
 * awaiting it (or .maybeSingle()) yields the configured result. */
function chain(result: { data?: unknown; error?: unknown }) {
  const promise = Promise.resolve({ data: null, error: null, ...result })
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'limit', 'in']) {
    c[m] = () => c
  }
  c.maybeSingle = () => promise
  c.single = () => promise
  c.then = promise.then.bind(promise)
  return c
}

function mockDb(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  return {
    from: (table: string) => chain(byTable[table] ?? {}),
  } as unknown as SupabaseClient
}

describe('monthWindow / previousMonth / defaultDeviationWindow', () => {
  it('spans a whole calendar month, February included', () => {
    expect(monthWindow(2026, 2)).toEqual({ start: '2026-02-01', end: '2026-02-28' })
    expect(monthWindow(2028, 2)).toEqual({ start: '2028-02-01', end: '2028-02-29' })
    expect(monthWindow(2026, 12)).toEqual({ start: '2026-12-01', end: '2026-12-31' })
  })

  it('rolls January back into December of the previous year', () => {
    expect(previousMonth(2026, 1)).toEqual({ year: 2025, month: 12 })
    expect(previousMonth(2026, 9)).toEqual({ year: 2026, month: 8 })
  })

  it('same_month reads the pay month, previous_month the month before', () => {
    expect(defaultDeviationWindow(2026, 9, 'same_month')).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
    })
    expect(defaultDeviationWindow(2026, 9, 'previous_month')).toEqual({
      start: '2026-08-01',
      end: '2026-08-31',
    })
    expect(defaultDeviationWindow(2026, 1, 'previous_month')).toEqual({
      start: '2025-12-01',
      end: '2025-12-31',
    })
  })
})

describe('runDeviationWindow / hasCustomDeviationWindow', () => {
  it('falls back to the pay month for runs created before the columns existed', () => {
    const run = { period_year: 2026, period_month: 9, deviation_period_start: null, deviation_period_end: null }
    expect(runDeviationWindow(run)).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(hasCustomDeviationWindow(run)).toBe(false)
  })

  it('uses the stored window when present', () => {
    const run = {
      period_year: 2026,
      period_month: 9,
      deviation_period_start: '2026-08-01',
      deviation_period_end: '2026-08-31',
    }
    expect(runDeviationWindow(run)).toEqual({ start: '2026-08-01', end: '2026-08-31' })
    expect(hasCustomDeviationWindow(run)).toBe(true)
  })

  it('a stored window equal to the pay month is not "custom"', () => {
    expect(
      hasCustomDeviationWindow({
        period_year: 2026,
        period_month: 9,
        deviation_period_start: '2026-09-01',
        deviation_period_end: '2026-09-30',
      }),
    ).toBe(false)
  })
})

describe('validateExplicitWindow', () => {
  it('accepts a proper window', () => {
    expect(validateExplicitWindow('2026-08-01', '2026-08-31')).toEqual({
      start: '2026-08-01',
      end: '2026-08-31',
    })
  })

  it.each([
    ['one bound only', '2026-08-01', undefined],
    ['non-ISO', '01/08/2026', '2026-08-31'],
    ['inverted', '2026-08-31', '2026-08-01'],
    ['over two months', '2026-06-01', '2026-08-31'],
    ['not a real date', '2026-02-30', '2026-03-01'],
    ['an overflowed day that Date.parse would normalise', '2026-02-30', '2026-03-31'],
    ['an overflowed end day', '2026-04-01', '2026-04-31'],
  ])('rejects %s with SALARY_RUN_DEVIATION_PERIOD_INVALID', (_label, start, end) => {
    let caught: unknown
    try {
      validateExplicitWindow(start, end)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SalaryDeviationPeriodError)
    expect((caught as SalaryDeviationPeriodError).code).toBe('SALARY_RUN_DEVIATION_PERIOD_INVALID')
  })
})

describe('resolveDeviationWindowForNewRun', () => {
  it('reads the company setting when no explicit dates are passed', async () => {
    const db = mockDb({ company_settings: { data: { salary_deviation_period: 'previous_month' } } })
    const resolved = await resolveDeviationWindowForNewRun(db, 'c1', { periodYear: 2026, periodMonth: 9 })
    expect(resolved).toEqual({
      window: { start: '2026-08-01', end: '2026-08-31' },
      source: 'setting',
      setting: 'previous_month',
    })
  })

  it('treats a missing settings row (fresh company) as same_month', async () => {
    const db = mockDb({ company_settings: { data: null } })
    const resolved = await resolveDeviationWindowForNewRun(db, 'c1', { periodYear: 2026, periodMonth: 9 })
    expect(resolved.window).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(resolved.setting).toBe('same_month')
  })

  it('explicit dates win over the setting', async () => {
    const db = mockDb({ company_settings: { data: { salary_deviation_period: 'previous_month' } } })
    const resolved = await resolveDeviationWindowForNewRun(db, 'c1', {
      periodYear: 2026,
      periodMonth: 9,
      explicitStart: '2026-08-16',
      explicitEnd: '2026-09-15',
    })
    expect(resolved).toEqual({
      window: { start: '2026-08-16', end: '2026-09-15' },
      source: 'explicit',
      setting: 'previous_month',
    })
  })

  it('one explicit date without the other is an error, not a silent default', async () => {
    const db = mockDb({ company_settings: { data: null } })
    await expect(
      resolveDeviationWindowForNewRun(db, 'c1', {
        periodYear: 2026,
        periodMonth: 9,
        explicitStart: '2026-08-01',
      }),
    ).rejects.toMatchObject({ code: 'SALARY_RUN_DEVIATION_PERIOD_INVALID' })
  })

  it('surfaces a settings read failure', async () => {
    const db = mockDb({ company_settings: { error: { message: 'boom' } } })
    await expect(
      resolveDeviationWindowForNewRun(db, 'c1', { periodYear: 2026, periodMonth: 9 }),
    ).rejects.toThrow(/Failed to load salary settings/)
  })
})

describe('assertNoDeviationOverlap', () => {
  const augustLegacyRun = {
    id: 'run-aug',
    period_year: 2026,
    period_month: 8,
    deviation_period_start: null,
    deviation_period_end: null,
  }

  it('passes when no run reads the same days', async () => {
    const db = mockDb({ salary_runs: { data: [augustLegacyRun] } })
    await expect(
      assertNoDeviationOverlap(db, 'c1', { start: '2026-09-01', end: '2026-09-30' }),
    ).resolves.toBeUndefined()
  })

  it('refuses a September run under previous_month when August was already read (mid-stream switch)', async () => {
    const db = mockDb({ salary_runs: { data: [augustLegacyRun] } })
    let caught: unknown
    try {
      await assertNoDeviationOverlap(db, 'c1', { start: '2026-08-01', end: '2026-08-31' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SalaryDeviationPeriodError)
    const e = caught as SalaryDeviationPeriodError
    expect(e.code).toBe('SALARY_RUN_DEVIATION_PERIOD_OVERLAP')
    expect(e.details).toMatchObject({
      conflicting_run_id: 'run-aug',
      conflicting_window_start: '2026-08-01',
      conflicting_window_end: '2026-08-31',
    })
  })

  it('a correction run keeps blocking a third run; only the corrected original is skipped', async () => {
    // After August is corrected: the original is status 'corrected' (the
    // query excludes it), the correction run is what the guard must see.
    const db = mockDb({
      salary_runs: {
        data: [
          {
            id: 'run-aug-correction',
            period_year: 2026,
            period_month: 8,
            deviation_period_start: null,
            deviation_period_end: null,
            is_correction: true,
          },
        ],
      },
    })
    await expect(
      assertNoDeviationOverlap(db, 'c1', { start: '2026-08-01', end: '2026-08-31' }),
    ).rejects.toMatchObject({
      code: 'SALARY_RUN_DEVIATION_PERIOD_OVERLAP',
      details: { conflicting_run_id: 'run-aug-correction' },
    })
  })

  it('a single shared day is an overlap', async () => {
    const db = mockDb({
      salary_runs: {
        data: [
          {
            id: 'run-x',
            period_year: 2026,
            period_month: 9,
            deviation_period_start: '2026-08-16',
            deviation_period_end: '2026-09-15',
          },
        ],
      },
    })
    await expect(
      assertNoDeviationOverlap(db, 'c1', { start: '2026-09-15', end: '2026-10-14' }),
    ).rejects.toMatchObject({ code: 'SALARY_RUN_DEVIATION_PERIOD_OVERLAP' })
    await expect(
      assertNoDeviationOverlap(db, 'c1', { start: '2026-09-16', end: '2026-10-15' }),
    ).resolves.toBeUndefined()
  })

  it('surfaces a query failure instead of silently allowing the run', async () => {
    const db = mockDb({ salary_runs: { error: { message: 'boom' } } })
    await expect(
      assertNoDeviationOverlap(db, 'c1', { start: '2026-09-01', end: '2026-09-30' }),
    ).rejects.toThrow(/Failed to check deviation period overlap/)
  })
})
