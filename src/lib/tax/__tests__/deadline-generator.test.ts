import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ANNUAL_HORIZON_DAYS,
  RECURRING_HORIZON_DAYS,
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
  kontrolluppgifter_enabled: false,
  rot_rut_enabled: false,
  oss_enabled: false,
  ioss_enabled: false,
  intrastat_enabled: false,
  punktskatt_enabled: false,
  fyllnadsinbetalning_enabled: false,
  tax_assessment_notices: [],
}

// Current + next year (the generator's own default): with the rolling
// horizon, rows only generate within ~6-12 months of today, so a
// next-year-only window would be empty for most of the year.
const CURRENT_YEAR = new Date().getFullYear()
const GEN_YEARS = [CURRENT_YEAR, CURRENT_YEAR + 1]

/** Period string for next month (YYYY-MM): always inside the horizon. */
function nextMonthPeriod(): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** A live system row the generator is about to replace. */
type SupersededRow = {
  tax_deadline_type: string
  tax_period: string
  status?: string
  status_changed_at?: string | null
  notes?: string | null
  due_time?: string | null
  priority?: string | null
  customer_id?: string | null
}

/**
 * Recording mock: captures the order of insert/delete operations and the
 * insert payload, so the tests can assert the insert-first/delete-after
 * ordering that prevents regeneration failures from wiping deadlines.
 */
function makeRecordingSupabase(opts: {
  insertError?: { code: string; message: string }
  completedRows?: Array<{ tax_deadline_type: string; tax_period: string }>
  supersededRows?: SupersededRow[]
} = {}) {
  const calls: string[] = []
  let insertPayload: Array<Record<string, unknown>> | null = null

  const from = vi.fn(() => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    let isDelete = false
    // The completed/dismissed lookup is the only read that uses .or();
    // the other read is the superseded-row lookup.
    let isCompletedQuery = false
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
    chain.or = vi.fn(() => {
      isCompletedQuery = true
      return chain
    })
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
      data: isCompletedQuery ? (opts.completedRows ?? []) : (opts.supersededRows ?? []),
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

    const result = await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)

    expect(calls[0]).toBe('insert')
    expect(calls[1]).toBe('delete')
    expect(result.created).toBeGreaterThan(0)
    expect(result.deleted).toBe(2)
  })

  it('excludes the newly inserted rows from the delete', async () => {
    const { supabase, calls } = makeRecordingSupabase()

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)

    expect(calls.some((c) => c.startsWith('not('))).toBe(true)
  })

  it('builds rows owned by company_id, without a user_id field', async () => {
    const { supabase, getInsertPayload } = makeRecordingSupabase()

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)

    const rows = getInsertPayload()
    expect(rows).not.toBeNull()
    for (const row of rows!) {
      expect(row.company_id).toBe('company-1')
      expect('user_id' in row).toBe(false)
      expect(row.source).toBe('system')
      expect(row.is_auto_generated).toBe(true)
    }
  })

  it('caps generation at the rolling horizon (6 months recurring, 12 months annual)', async () => {
    const { supabase, getInsertPayload } = makeRecordingSupabase()

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)

    const rows = getInsertPayload()
    expect(rows).not.toBeNull()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const daysOut = (dueDate: string) =>
      Math.round((new Date(`${dueDate}T00:00:00`).getTime() - today.getTime()) / 86_400_000)

    const recurring = new Set([
      'moms_monthly', 'moms_quarterly', 'f_skatt',
      'arbetsgivardeklaration', 'skatteinbetalning', 'periodisk_sammanstallning',
    ])
    for (const row of rows!) {
      const limit = recurring.has(row.tax_deadline_type as string)
        ? RECURRING_HORIZON_DAYS
        : ANNUAL_HORIZON_DAYS
      expect(daysOut(row.due_date as string)).toBeLessThanOrEqual(limit)
    }
    // The old 17-month window is gone: nothing sits beyond a year out.
    expect(rows!.every((row) => daysOut(row.due_date as string) <= ANNUAL_HORIZON_DAYS)).toBe(true)
    // But the near-term rows are all there (monthly settings → rows exist).
    expect(rows!.length).toBeGreaterThan(0)
  })

  it('does not delete existing deadlines when the insert fails', async () => {
    const { supabase, calls } = makeRecordingSupabase({
      insertError: { code: '23502', message: 'null value in column "user_id"' },
    })

    await expect(
      generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)
    ).rejects.toMatchObject({ code: '23502' })

    expect(calls).toContain('insert')
    expect(calls).not.toContain('delete')
  })

  it('does not replace a completed future obligation with a new pending row', async () => {
    const completedPeriod = nextMonthPeriod()
    const { supabase, getInsertPayload } = makeRecordingSupabase({
      completedRows: [{ tax_deadline_type: 'f_skatt', tax_period: completedPeriod }],
    })

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)

    expect(getInsertPayload()).not.toContainEqual(expect.objectContaining({
      tax_deadline_type: 'f_skatt',
      tax_period: completedPeriod,
    }))
  })

  it('keeps a manually set in_progress status on the replacement row', async () => {
    const period = nextMonthPeriod()
    const { supabase, getInsertPayload } = makeRecordingSupabase({
      supersededRows: [
        { tax_deadline_type: 'f_skatt', tax_period: period, status: 'in_progress' },
      ],
    })

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)

    const replaced = getInsertPayload()!.find(
      (row) => row.tax_deadline_type === 'f_skatt' && row.tax_period === period,
    )
    expect(replaced).toBeDefined()
    expect(replaced!.status).toBe('in_progress')
    // Other rows keep the computed status.
    const other = getInsertPayload()!.find(
      (row) => row.tax_deadline_type === 'f_skatt' && row.tax_period !== period,
    )
    expect(other?.status).not.toBe('in_progress')
  })

  it('links a kvarskatt deadline to the notice that supplied its exact date', async () => {
    const due = new Date()
    due.setDate(due.getDate() + 30)
    const paymentDueDate = [
      due.getFullYear(),
      String(due.getMonth() + 1).padStart(2, '0'),
      String(due.getDate()).padStart(2, '0'),
    ].join('-')
    const { supabase, getInsertPayload } = makeRecordingSupabase()

    await generateTaxDeadlinesForUser(supabase, 'company-1', {
      ...SETTINGS,
      tax_assessment_notices: [{
        id: 'notice-1',
        fiscalPeriodName: '2025',
        decisionType: 'reassessment',
        paymentDueDate,
      }],
    }, GEN_YEARS)

    expect(getInsertPayload()).toContainEqual(expect.objectContaining({
      tax_deadline_type: 'kvarskatt',
      tax_period: 'notice:notice-1',
      due_date: paymentDueDate,
      tax_assessment_notice_id: 'notice-1',
    }))
  })
})

/**
 * Regeneration deletes and reinserts, so anything the replacement row does not
 * carry across is silently discarded. The rule: the generator owns what the
 * statute decides (title, due date, linked report), the row owns every mark a
 * person put on it (notes, clock time, priority, manually reported status).
 */
describe('generateTaxDeadlinesForUser: what survives regeneration', () => {
  const period = nextMonthPeriod()

  /** The replacement row for the edited f-skatt obligation. */
  async function regenerateWith(superseded: SupersededRow) {
    const { supabase, getInsertPayload } = makeRecordingSupabase({
      supersededRows: [superseded],
    })
    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)
    const rows = getInsertPayload()!
    return {
      replaced: rows.find(
        (row) => row.tax_deadline_type === 'f_skatt' && row.tax_period === period,
      )!,
      untouched: rows.find(
        (row) => row.tax_deadline_type === 'f_skatt' && row.tax_period !== period,
      )!,
      rows,
    }
  }

  it('keeps a note the user wrote on a system deadline', async () => {
    const { replaced, untouched } = await regenerateWith({
      tax_deadline_type: 'f_skatt',
      tax_period: period,
      notes: 'Ring revisorn innan betalning',
    })

    expect(replaced.notes).toBe('Ring revisorn innan betalning')
    // A row with nothing to inherit still gets the column (PostgREST bulk
    // inserts reject objects whose key sets differ).
    expect(untouched.notes).toBeNull()
  })

  it('keeps a priority the user raised on a system deadline', async () => {
    const { replaced, untouched } = await regenerateWith({
      tax_deadline_type: 'f_skatt',
      tax_period: period,
      priority: 'critical',
    })

    expect(replaced.priority).toBe('critical')
    // Untouched rows keep the template priority.
    expect(untouched.priority).toBe('important')
  })

  it('keeps a due_time the user set on a system deadline', async () => {
    const { replaced, untouched } = await regenerateWith({
      tax_deadline_type: 'f_skatt',
      tax_period: period,
      due_time: '09:00:00',
    })

    expect(replaced.due_time).toBe('09:00:00')
    // The generator never sets a clock time itself.
    expect(untouched.due_time).toBeNull()
  })

  it('keeps a customer link the user made on a system deadline', async () => {
    const { replaced } = await regenerateWith({
      tax_deadline_type: 'f_skatt',
      tax_period: period,
      customer_id: '11111111-1111-1111-1111-111111111111',
    })

    expect(replaced.customer_id).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('keeps every user edit at once, not just the last one added', async () => {
    const { replaced } = await regenerateWith({
      tax_deadline_type: 'f_skatt',
      tax_period: period,
      status: 'in_progress',
      notes: 'Underlag hos byrån',
      due_time: '17:00:00',
      priority: 'critical',
    })

    expect(replaced).toMatchObject({
      status: 'in_progress',
      notes: 'Underlag hos byrån',
      due_time: '17:00:00',
      priority: 'critical',
    })
  })

  it('keeps a manually reported submitted status, not just in_progress', async () => {
    // 'submitted' leaves is_completed false, so the row IS replaced: without
    // preservation the user's "I have filed this" report silently reverts.
    const { replaced } = await regenerateWith({
      tax_deadline_type: 'f_skatt',
      tax_period: period,
      status: 'submitted',
      status_changed_at: '2020-01-02T03:04:05.000Z',
    })

    expect(replaced.status).toBe('submitted')
    // The mark keeps its own timestamp: it was not made just now.
    expect(replaced.status_changed_at).toBe('2020-01-02T03:04:05.000Z')
  })

  it('recomputes the date-derived statuses instead of freezing them', async () => {
    // 'upcoming' is the status engine's own output, not a user report: a row
    // whose due date has since moved inside the 14-day window must become
    // action_needed rather than inherit a stale 'upcoming'.
    const { rows } = await regenerateWith({
      tax_deadline_type: 'f_skatt',
      tax_period: period,
      status: 'upcoming',
      status_changed_at: '2020-01-02T03:04:05.000Z',
    })

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    for (const row of rows) {
      const daysUntil = Math.ceil(
        (new Date(`${row.due_date as string}T00:00:00`).getTime() - today.getTime()) / 86_400_000,
      )
      expect(row.status).toBe(daysUntil <= 14 ? 'action_needed' : 'upcoming')
      expect(row.status_changed_at).not.toBe('2020-01-02T03:04:05.000Z')
    }
  })

  it('still propagates the statutory title and due date to an untouched row', async () => {
    // The schema cannot tell a user edit apart from a template change on the
    // statutory columns, so the template always wins there: a corrected date
    // or a renamed obligation must reach rows nobody touched.
    const { supabase, getInsertPayload } = makeRecordingSupabase({
      supersededRows: [
        {
          tax_deadline_type: 'f_skatt',
          tax_period: period,
          // Values from a superseded schedule / an older title template.
          notes: 'behåll mig',
        },
      ],
    })

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)

    const replaced = getInsertPayload()!.find(
      (row) => row.tax_deadline_type === 'f_skatt' && row.tax_period === period,
    )!
    // Title comes from the current template, not from the replaced row.
    const monthNames = [
      'januari', 'februari', 'mars', 'april', 'maj', 'juni',
      'juli', 'augusti', 'september', 'oktober', 'november', 'december',
    ]
    const [labelYear, labelMonth] = period.split('-')
    expect(replaced.title).toBe(
      `Betala preliminärskatt ${monthNames[Number(labelMonth) - 1]} ${labelYear}`,
    )
    // due_date must equal the schedule's own computed date, which is exactly
    // what getExpectedUpcomingDeadlineKeys expects; otherwise the backfill
    // cron flags this company forever.
    expect(
      getExpectedUpcomingDeadlineKeys(SETTINGS, GEN_YEARS).has(
        `f_skatt:${period}:${replaced.due_date as string}`,
      ),
    ).toBe(true)
    expect(replaced.notes).toBe('behåll mig')
  })

  it('drops an obligation the settings no longer produce, edits and all', async () => {
    // Deliberate: turning off vat_registered is the user's own statement that
    // the obligation does not apply. Keeping an edited momsdeklaration row
    // would leave a phantom statutory deadline on the page.
    const { supabase, getInsertPayload } = makeRecordingSupabase({
      supersededRows: [
        {
          tax_deadline_type: 'moms_monthly',
          tax_period: period,
          notes: 'anteckning på en moms-deadline',
          priority: 'critical',
        },
      ],
    })

    await generateTaxDeadlinesForUser(
      supabase,
      'company-1',
      { ...SETTINGS, vat_registered: false, moms_period: null },
      GEN_YEARS,
    )

    expect(getInsertPayload()!.some((row) => row.tax_deadline_type === 'moms_monthly')).toBe(false)
  })

  it('never inherits user_id: system deadlines stay company-owned', async () => {
    const { rows } = await regenerateWith({
      tax_deadline_type: 'f_skatt',
      tax_period: period,
      notes: 'x',
    })

    for (const row of rows) {
      expect('user_id' in row).toBe(false)
    }
  })

  it('gives every inserted row the identical key set', async () => {
    // PostgREST rejects a bulk insert whose objects have differing keys
    // (PGRST102), so an inherited column must be present-and-null rather
    // than omitted on rows with nothing to inherit.
    const { rows } = await regenerateWith({
      tax_deadline_type: 'f_skatt',
      tax_period: period,
      notes: 'x',
      due_time: '08:00:00',
      customer_id: '11111111-1111-1111-1111-111111111111',
    })

    const keys = rows.map((row) => Object.keys(row).sort().join(','))
    expect(new Set(keys).size).toBe(1)
  })
})

describe('getExpectedUpcomingDeadlineKeys: banking-day handling', () => {
  it('keeps EU-law deadlines (IOSS) on the raw date even when it is a Sunday', () => {
    // 2030-03-31 (IOSS for February 2030) is a Sunday; the banking-day
    // adjustment would move it to 2030-04-01, but EU deadlines stand.
    const keys = getExpectedUpcomingDeadlineKeys(
      { ...SETTINGS, ioss_enabled: true },
      [2030],
      new Date(2030, 0, 1),
    )
    expect(keys.has('ioss_monthly:2030-02:2030-03-31')).toBe(true)
    expect(keys.has('ioss_monthly:2030-02:2030-04-01')).toBe(false)
  })

  it('still shifts ordinary Skatteverket deadlines to the next banking day', () => {
    // 12 January 2030 is a Saturday; the January f-skatt date is the 17th
    // (a Thursday) so use February: 12 Feb 2030 is a Tuesday. Take May
    // instead: 2030-05-12 is a Sunday → shifted to Monday 2030-05-13.
    const keys = getExpectedUpcomingDeadlineKeys(SETTINGS, [2030], new Date(2030, 0, 1))
    expect(keys.has('f_skatt:2030-05:2030-05-13')).toBe(true)
    expect(keys.has('f_skatt:2030-05:2030-05-12')).toBe(false)
  })

  it('keeps an exact kvarskatt notice date on a Sunday', () => {
    const keys = getExpectedUpcomingDeadlineKeys({
      ...SETTINGS,
      tax_assessment_notices: [{
        id: 'notice-1',
        fiscalPeriodName: '2029',
        decisionType: 'final',
        paymentDueDate: '2030-03-31',
      }],
    }, [2030], new Date(2030, 0, 1))

    expect(keys.has('kvarskatt:notice:notice-1:2030-03-31')).toBe(true)
    expect(keys.has('kvarskatt:notice:notice-1:2030-04-01')).toBe(false)
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
