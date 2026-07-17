import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  findSettingsMissingUpcomingDeadlines,
  generateTaxDeadlinesForUser,
  getExpectedUpcomingDeadlineKeys,
  shouldRegenerateTaxDeadlines,
} from '../deadline-generator'
import type { CompanySettingsForDeadlines } from '../deadline-config'

const SETTINGS: CompanySettingsForDeadlines = {
  entity_type: 'aktiebolag',
  moms_period: 'monthly',
  f_skatt: true,
  preliminary_tax_monthly: 5000,
  vat_registered: true,
  pays_salaries: true,
  employer_registered: null,
  employer_seasonal: false,
  fiscal_year_start_month: 1,
  vat_taxable_base_over_40m: false,
  vat_has_eu_trade: false,
  vat_filing_method: 'electronic',
  periodisk_sammanstallning_enabled: false,
  periodisk_sammanstallning_period: 'monthly',
  periodisk_sammanstallning_filing_method: 'electronic',
}

// Future year so generated dates are never skipped as "in the past".
const FUTURE_YEAR = new Date().getFullYear() + 1

/**
 * Recording mock: captures the order of insert/delete operations and the
 * insert payload, so the tests can assert the insert-first/delete-after
 * ordering that prevents regeneration failures from wiping deadlines.
 */
function makeRecordingSupabase(opts: {
  insertError?: { code: string; message: string }
  completedRows?: Array<{ tax_deadline_type: string; tax_period: string }>
} = {}) {
  const calls: string[] = []
  let insertPayload: Array<Record<string, unknown>> | null = null

  const from = vi.fn(() => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    let isDelete = false
    const self = () => chain
    chain.insert = vi.fn((rows: Array<Record<string, unknown>>) => {
      calls.push('insert')
      insertPayload = rows
      return {
        select: vi.fn(async () =>
          opts.insertError
            ? { data: null, error: opts.insertError }
            : { data: rows.map((_, i) => ({ id: `new-${i}` })), error: null }
        ),
      }
    })
    chain.delete = vi.fn(() => {
      calls.push('delete')
      isDelete = true
      return chain
    })
    chain.eq = vi.fn(self)
    chain.or = vi.fn(self)
    chain.is = vi.fn(self)
    chain.gte = vi.fn(self)
    chain.lte = vi.fn(self)
    chain.not = vi.fn((...args: unknown[]) => {
      calls.push(`not(${String(args[2]).slice(0, 20)}…)`)
      return chain
    })
    chain.select = vi.fn(() => {
      if (isDelete) {
        return Promise.resolve({ data: [{ id: 'old-1' }, { id: 'old-2' }], error: null })
      }
      return chain
    })
    chain.then = vi.fn((resolve: (value: unknown) => unknown) => Promise.resolve({
      data: opts.completedRows ?? [],
      error: null,
    }).then(resolve))
    return chain
  })

  return {
    supabase: { from } as unknown as SupabaseClient,
    calls,
    getInsertPayload: () => insertPayload,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('generateTaxDeadlinesForUser', () => {
  it('inserts replacement rows before deleting the old set', async () => {
    const { supabase, calls } = makeRecordingSupabase()

    const result = await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, [FUTURE_YEAR])

    expect(calls[0]).toBe('insert')
    expect(calls[1]).toBe('delete')
    expect(result.created).toBeGreaterThan(0)
    expect(result.deleted).toBe(2)
  })

  it('excludes the newly inserted rows from the delete', async () => {
    const { supabase, calls } = makeRecordingSupabase()

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, [FUTURE_YEAR])

    expect(calls.some((c) => c.startsWith('not('))).toBe(true)
  })

  it('builds rows owned by company_id, without a user_id field', async () => {
    const { supabase, getInsertPayload } = makeRecordingSupabase()

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, [FUTURE_YEAR])

    const rows = getInsertPayload()
    expect(rows).not.toBeNull()
    for (const row of rows!) {
      expect(row.company_id).toBe('company-1')
      expect('user_id' in row).toBe(false)
      expect(row.source).toBe('system')
      expect(row.is_auto_generated).toBe(true)
    }
  })

  it('does not delete existing deadlines when the insert fails', async () => {
    const { supabase, calls } = makeRecordingSupabase({
      insertError: { code: '23502', message: 'null value in column "user_id"' },
    })

    await expect(
      generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, [FUTURE_YEAR])
    ).rejects.toMatchObject({ code: '23502' })

    expect(calls).toContain('insert')
    expect(calls).not.toContain('delete')
  })

  it('does not replace a completed future obligation with a new pending row', async () => {
    const completedPeriod = `${FUTURE_YEAR}-01`
    const { supabase, getInsertPayload } = makeRecordingSupabase({
      completedRows: [{ tax_deadline_type: 'f_skatt', tax_period: completedPeriod }],
    })

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, [FUTURE_YEAR])

    expect(getInsertPayload()).not.toContainEqual(expect.objectContaining({
      tax_deadline_type: 'f_skatt',
      tax_period: completedPeriod,
    }))
  })
})

describe('findSettingsMissingUpcomingDeadlines', () => {
  const fromDate = new Date(2030, 0, 1)
  const years = [2030]

  function rowsFor(
    companyId: string,
    keys: Set<string>,
    isCompleted = false,
    dismissedAt: string | null = null,
  ) {
    return Array.from(keys, (key, index) => {
      const [taxDeadlineType, taxPeriod, dueDate] = key.split(':')
      return {
        id: `${companyId}-${index}`,
        company_id: companyId,
        tax_deadline_type: taxDeadlineType,
        tax_period: taxPeriod,
        due_date: dueDate,
        is_completed: isCompleted,
        dismissed_at: dismissedAt,
      }
    })
  }

  it('returns only companies missing at least one expected obligation', () => {
    const settings = [
      { company_id: 'company-1', ...SETTINGS },
      { company_id: 'company-2', ...SETTINGS },
    ]
    const completeRows = rowsFor(
      'company-1',
      getExpectedUpcomingDeadlineKeys(SETTINGS, years, fromDate),
    )

    expect(findSettingsMissingUpcomingDeadlines(
      settings,
      completeRows,
      years,
      fromDate,
    )).toEqual([settings[1]])
  })

  it('repairs a company that has F-tax deadlines but is missing VAT deadlines', () => {
    const settings = [{ company_id: 'company-1', ...SETTINGS }]
    const expectedKeys = getExpectedUpcomingDeadlineKeys(SETTINGS, years, fromDate)
    const fTaxRows = rowsFor(
      'company-1',
      new Set(Array.from(expectedKeys).filter((key) => key.startsWith('f_skatt:'))),
    )

    expect(findSettingsMissingUpcomingDeadlines(
      settings,
      fTaxRows,
      years,
      fromDate,
    )).toEqual(settings)
  })

  it('repairs a company whose rows carry dates from a superseded schedule', () => {
    const settings = [{ company_id: 'company-1', ...SETTINGS }]
    const staleRows = rowsFor(
      'company-1',
      getExpectedUpcomingDeadlineKeys(SETTINGS, years, fromDate),
    ).map((row) => ({ ...row, due_date: '2030-12-31' }))

    expect(findSettingsMissingUpcomingDeadlines(
      settings,
      staleRows,
      years,
      fromDate,
    )).toEqual(settings)
  })

  it('treats a completed obligation as satisfied even with a superseded due date', () => {
    // A filed (is_completed) row keeps its old statutory date. The generator
    // never replaces completed rows, so flagging it by date would make the
    // repair loop re-run for this company every day without converging.
    const settings = [{ company_id: 'company-1', ...SETTINGS }]
    const completedStaleRows = rowsFor(
      'company-1',
      getExpectedUpcomingDeadlineKeys(SETTINGS, years, fromDate),
      true,
    ).map((row) => ({ ...row, due_date: '2029-01-15' }))

    expect(findSettingsMissingUpcomingDeadlines(
      settings,
      completedStaleRows,
      years,
      fromDate,
    )).toEqual([])
  })

  it('treats a dismissed obligation as satisfied even with a superseded due date', () => {
    // A dismissed row is an explicit opt-out. The generator never replaces
    // dismissed rows, so flagging one by date would resurrect the obligation
    // the user opted out of on every cron run.
    const settings = [{ company_id: 'company-1', ...SETTINGS }]
    const dismissedStaleRows = rowsFor(
      'company-1',
      getExpectedUpcomingDeadlineKeys(SETTINGS, years, fromDate),
      false,
      '2029-06-01T00:00:00Z',
    ).map((row) => ({ ...row, due_date: '2029-01-15' }))

    expect(findSettingsMissingUpcomingDeadlines(
      settings,
      dismissedStaleRows,
      years,
      fromDate,
    )).toEqual([])
  })

  it('still repairs missing pending obligations when other obligations are completed', () => {
    const settings = [{ company_id: 'company-1', ...SETTINGS }]
    const expectedKeys = getExpectedUpcomingDeadlineKeys(SETTINGS, years, fromDate)
    // Only the F-tax obligations exist (completed); everything else is missing.
    const completedFTaxRows = rowsFor(
      'company-1',
      new Set(Array.from(expectedKeys).filter((key) => key.startsWith('f_skatt:'))),
      true,
    )

    expect(findSettingsMissingUpcomingDeadlines(
      settings,
      completedFTaxRows,
      years,
      fromDate,
    )).toEqual(settings)
  })
})

describe('shouldRegenerateTaxDeadlines', () => {
  it('regenerates when a tax-relevant field changed', () => {
    expect(shouldRegenerateTaxDeadlines(true, 42)).toBe(true)
  })

  it('regenerates when the company has no system deadlines yet, even with no field change', () => {
    // The reported bug: settings were filled at onboarding, so a later save with
    // no tax-field change never generated deadlines and the page stayed empty.
    expect(shouldRegenerateTaxDeadlines(false, 0)).toBe(true)
  })

  it('does not regenerate when nothing changed and deadlines already exist', () => {
    // Avoid clobbering existing status/progress on unrelated settings saves.
    expect(shouldRegenerateTaxDeadlines(false, 12)).toBe(false)
  })
})
