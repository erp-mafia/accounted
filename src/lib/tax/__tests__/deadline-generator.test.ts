import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ANNUAL_HORIZON_DAYS,
  RECURRING_HORIZON_DAYS,
  backfillMissingTaxDeadlines,
  findSettingsMissingUpcomingDeadlines,
  findSettingsWithStaleUpcomingDeadlines,
  generateTaxDeadlinesForUser,
  getExpectedUpcomingDeadlineKeys,
  shouldRegenerateTaxDeadlines,
  toDeadlineSettings,
} from '../deadline-generator'
import type { CompanySettingsForDeadlines } from '../deadline-config'
import { createRowsMockSupabase } from '@/tests/helpers'

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
  fiscalPeriods?: Array<{ company_id: string; period_start: string; period_end: string }>
  /** The AGI filing records, answered through the filters the generator applies. */
  agiKvittenser?: Array<Record<string, unknown>>
  agiDeclarations?: Array<Record<string, unknown>>
  /** employees rows, answered through the filters the generator applies. */
  employees?: Array<Record<string, unknown>>
} = {}) {
  const calls: string[] = []
  let insertPayload: Array<Record<string, unknown>> | null = null
  const filings = createRowsMockSupabase({
    agi_kvittenser: opts.agiKvittenser ?? [],
    agi_declarations: opts.agiDeclarations ?? [],
    employees: opts.employees ?? [],
  })

  const from = vi.fn((table: string) => {
    if (table === 'agi_kvittenser' || table === 'agi_declarations' || table === 'employees') {
      return filings.supabase.from(table)
    }
    if (table === 'fiscal_periods') {
      // The generator's own fiscal-year lookup (paginated).
      const periods: Record<string, ReturnType<typeof vi.fn>> = {}
      periods.select = vi.fn(() => periods)
      periods.eq = vi.fn(() => periods)
      periods.order = vi.fn(() => periods)
      periods.range = vi.fn(async () => ({ data: opts.fiscalPeriods ?? [], error: null }))
      return periods
    }
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

/**
 * #201: a company files its AGI before it has any AGI deadline (a new
 * company's first AGI), and the deadline the generator creates afterwards
 * must not ask for a filing Skatteverket already has. Today is 9 November
 * 2026: the October period is due 12 November, November's on 14 December.
 */
describe('generateTaxDeadlinesForUser: an AGI period filed before its deadline existed (#201)', () => {
  const OCTOBER = 'arbetsgivardeklaration:2026-10'
  const NOVEMBER = 'arbetsgivardeklaration:2026-11'

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 9, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function kvittens(overrides: Record<string, unknown> = {}) {
    return {
      company_id: 'company-1',
      period_year: 2026,
      period_month: 10,
      signerad_tid: '2026-11-07T09:15:00+00:00',
      recorded_at: '2026-11-07T12:00:00+00:00',
      ...overrides,
    }
  }

  function declaration(overrides: Record<string, unknown> = {}) {
    return {
      company_id: 'company-1',
      period_year: 2026,
      period_month: 10,
      status: 'submitted',
      submitted_at: '2026-11-07T09:15:00+00:00',
      ...overrides,
    }
  }

  async function generate(
    opts: Parameters<typeof makeRecordingSupabase>[0] = {},
    settings: CompanySettingsForDeadlines = SETTINGS,
  ) {
    const recording = makeRecordingSupabase(opts)
    await generateTaxDeadlinesForUser(recording.supabase, 'company-1', settings)
    const rows = recording.getInsertPayload()!
    const byKey = new Map(rows.map((row) => [`${row.tax_deadline_type}:${row.tax_period}`, row]))
    return { ...recording, rows, byKey }
  }

  it('creates a period with a kvittens completed, at the signing moment', async () => {
    const { byKey } = await generate({ agiKvittenser: [kvittens()] })

    expect(byKey.get(OCTOBER)).toMatchObject({
      due_date: '2026-11-12',
      is_completed: true,
      status: 'confirmed',
      completed_at: '2026-11-07T09:15:00+00:00',
    })
  })

  it('creates an unfiled period open, as before', async () => {
    const { byKey } = await generate({ agiKvittenser: [kvittens()] })

    expect(byKey.get(NOVEMBER)).toMatchObject({
      due_date: '2026-12-14',
      is_completed: false,
      completed_at: null,
      status: 'upcoming',
    })
  })

  it('counts a submitted or accepted declaration as filed, and no other status', async () => {
    const { byKey } = await generate({
      agiDeclarations: [
        declaration(),
        declaration({ period_month: 11, status: 'pending_signature', submitted_at: null }),
        declaration({ period_month: 12, status: 'exported', submitted_at: null }),
        declaration({ period_year: 2027, period_month: 1, status: 'accepted', submitted_at: '2027-01-02T08:00:00+00:00' }),
      ],
    })

    expect(byKey.get(OCTOBER)).toMatchObject({ is_completed: true, status: 'confirmed', completed_at: '2026-11-07T09:15:00+00:00' })
    expect(byKey.get(NOVEMBER)).toMatchObject({ is_completed: false, status: 'upcoming' })
    expect(byKey.get('arbetsgivardeklaration:2026-12')).toMatchObject({ is_completed: false })
    expect(byKey.get('arbetsgivardeklaration:2027-01')).toMatchObject({ is_completed: true, completed_at: '2027-01-02T08:00:00+00:00' })
  })

  it('keeps the first filing when a correction was filed later', async () => {
    const { byKey } = await generate({
      agiKvittenser: [
        kvittens({ signerad_tid: '2026-11-08T10:00:00+00:00', recorded_at: '2026-11-08T10:05:00+00:00' }),
        kvittens(),
      ],
      // The declaration row holds the latest receipt: the correction's.
      agiDeclarations: [declaration({ submitted_at: '2026-11-08T10:00:00+00:00' })],
    })

    expect(byKey.get(OCTOBER)!.completed_at).toBe('2026-11-07T09:15:00+00:00')
  })

  it('uses the moment the receipt was read when Skatteverket sent no signing time', async () => {
    const { byKey } = await generate({ agiKvittenser: [kvittens({ signerad_tid: null })] })

    expect(byKey.get(OCTOBER)!.completed_at).toBe('2026-11-07T12:00:00+00:00')
  })

  it('completes a submitted declaration without a recorded time as of now', async () => {
    const { byKey } = await generate({ agiDeclarations: [declaration({ submitted_at: null })] })

    expect(byKey.get(OCTOBER)).toMatchObject({ is_completed: true, completed_at: new Date().toISOString() })
  })

  it('does not count another company\'s filing', async () => {
    const { byKey } = await generate({
      agiKvittenser: [kvittens({ company_id: 'company-2' })],
      agiDeclarations: [declaration({ company_id: 'company-2' })],
    })

    expect(byKey.get(OCTOBER)).toMatchObject({ is_completed: false, status: 'action_needed' })
  })

  it('leaves every other obligation open, the same period\'s tax payment too', async () => {
    // Storföretag: the 26th filing and a separate payment deadline on the
    // 12th for the same period. Filing the AGI does not pay it.
    const storforetag = { ...SETTINGS, vat_taxable_base_over_40m: true }
    const { rows, byKey } = await generate({ agiKvittenser: [kvittens()] }, storforetag)

    expect(byKey.get(OCTOBER)).toMatchObject({ is_completed: true, due_date: '2026-11-26' })
    expect(byKey.get('skatteinbetalning:2026-10')).toMatchObject({ is_completed: false, completed_at: null })
    for (const row of rows.filter((r) => `${r.tax_deadline_type}:${r.tax_period}` !== OCTOBER)) {
      expect(row).toMatchObject({ is_completed: false, completed_at: null })
      expect(row.status).not.toBe('confirmed')
    }
  })

  it('replaces an open row for a filed period, keeping what the user wrote on it', async () => {
    // The 12 open October and November rows in production: an open row the
    // generator replaces becomes completed, with its note.
    const { byKey } = await generate({
      agiKvittenser: [kvittens()],
      supersededRows: [{ tax_deadline_type: 'arbetsgivardeklaration', tax_period: '2026-10', status: 'in_progress', notes: 'Lön utbetald 25:e' }],
    })

    expect(byKey.get(OCTOBER)).toMatchObject({ is_completed: true, status: 'confirmed', notes: 'Lön utbetald 25:e' })
  })

  it('still preserves an already completed or dismissed row instead of inserting another', async () => {
    const { rows } = await generate({
      agiKvittenser: [kvittens(), kvittens({ period_month: 11 })],
      completedRows: [
        { tax_deadline_type: 'arbetsgivardeklaration', tax_period: '2026-10' },
        { tax_deadline_type: 'arbetsgivardeklaration', tax_period: '2026-11' },
      ],
    })

    const keys = rows.map((row) => `${row.tax_deadline_type}:${row.tax_period}`)
    expect(keys).not.toContain(OCTOBER)
    expect(keys).not.toContain(NOVEMBER)
  })

  it('gives completed and open rows the identical key set (PGRST102)', async () => {
    const { rows } = await generate({ agiKvittenser: [kvittens()] })

    expect(rows.some((row) => row.is_completed)).toBe(true)
    expect(rows.some((row) => !row.is_completed)).toBe(true)
    expect(new Set(rows.map((row) => Object.keys(row).sort().join(','))).size).toBe(1)
  })

  it('does not read the filing records for a company without AGI deadlines', async () => {
    const { supabase } = await generate({}, { ...SETTINGS, pays_salaries: false })

    expect(supabase.from).not.toHaveBeenCalledWith('agi_kvittenser')
    expect(supabase.from).not.toHaveBeenCalledWith('agi_declarations')
  })

  it('converges: the nightly backfill treats the completed row as satisfied', async () => {
    const settingsRow = { company_id: 'company-1', ...SETTINGS, fiscal_years: [] }
    const { rows } = await generate({ agiKvittenser: [kvittens()] })
    const stored = rows.map((row, index) => ({
      id: `row-${index}`,
      company_id: 'company-1',
      tax_deadline_type: row.tax_deadline_type as string,
      tax_period: row.tax_period as string,
      due_date: row.due_date as string,
      is_completed: row.is_completed as boolean,
      dismissed_at: null,
    }))

    // The completed row carries the date detection expects.
    expect(stored.find((row) => `${row.tax_deadline_type}:${row.tax_period}` === OCTOBER))
      .toMatchObject({ due_date: '2026-11-12', is_completed: true })
    expect(getExpectedUpcomingDeadlineKeys(SETTINGS).has(`${OCTOBER}:2026-11-12`)).toBe(true)
    expect(findSettingsMissingUpcomingDeadlines([settingsRow], stored)).toEqual([])
    expect(findSettingsWithStaleUpcomingDeadlines([settingsRow], stored)).toEqual([])
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

describe('generateTaxDeadlinesForUser: the company\'s real räkenskapsår (crm#1278)', () => {
  // An AB registered mid-October 2026 whose first räkenskapsår is extended
  // to 31 December 2027, quarterly moms, generated on 16 October 2026.
  const NEW_COMPANY: CompanySettingsForDeadlines = {
    ...SETTINGS,
    moms_period: 'quarterly',
    preliminary_tax_monthly: null,
    pays_salaries: false,
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 16, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads fiscal_periods and inserts no row for a räkenskapsår or quarter that never existed', async () => {
    const { supabase, getInsertPayload } = makeRecordingSupabase({
      fiscalPeriods: [{ company_id: 'company-1', period_start: '2026-10-12', period_end: '2027-12-31' }],
    })

    await generateTaxDeadlinesForUser(supabase, 'company-1', NEW_COMPANY)

    expect(supabase.from).toHaveBeenCalledWith('fiscal_periods')
    expect(getInsertPayload()!.map((row) => `${row.tax_deadline_type}:${row.tax_period}:${row.due_date}`))
      .toEqual(['moms_quarterly:2026-Q4:2027-02-12'])
  })

  it('keeps the twelve-month schedule for a company without recorded fiscal periods', async () => {
    const { supabase, getInsertPayload } = makeRecordingSupabase({ fiscalPeriods: [] })

    await generateTaxDeadlinesForUser(supabase, 'company-1', NEW_COMPANY)

    expect(getInsertPayload()!.map((row) => `${row.tax_deadline_type}:${row.tax_period}`).sort()).toEqual([
      'arsredovisning:2026',
      'arsstamma:2026',
      'inkomstdeklaration_ab:2026',
      'moms_quarterly:2026-Q3',
      'moms_quarterly:2026-Q4',
    ])
  })

  it('does not query fiscal_periods when the caller already resolved them', async () => {
    const { supabase } = makeRecordingSupabase()

    await generateTaxDeadlinesForUser(supabase, 'company-1', { ...NEW_COMPANY, fiscal_years: [] })

    expect(supabase.from).not.toHaveBeenCalledWith('fiscal_periods')
  })

  it('carries resolved fiscal years through toDeadlineSettings', () => {
    const fiscalYears = [{ start: '2026-10-12', end: '2027-12-31' }]
    expect(toDeadlineSettings({ ...SETTINGS, fiscal_years: fiscalYears }).fiscal_years).toEqual(fiscalYears)
  })
})

describe('AGI rows for an active salaried employee before the first salary run (crm#1790)', () => {
  // An AB that set up its first employee but has not booked a salary run, so
  // neither employer flag was ever attested (the booked-run trigger never
  // fired). Generated on 9 November 2026.
  const UNATTESTED: CompanySettingsForDeadlines = {
    ...SETTINGS,
    moms_period: 'quarterly',
    preliminary_tax_monthly: null,
    pays_salaries: false,
    employer_registered: null,
    fiscal_years: [],
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 9, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function employee(overrides: Record<string, unknown> = {}) {
    return {
      id: 'employee-1',
      company_id: 'company-1',
      is_active: true,
      employment_start: '2026-03-01',
      monthly_salary: 30000,
      hourly_rate: null,
      ...overrides,
    }
  }

  async function agiRows(
    employees: Array<Record<string, unknown>>,
    settings: CompanySettingsForDeadlines = UNATTESTED,
  ) {
    const recording = makeRecordingSupabase({ employees })
    await generateTaxDeadlinesForUser(recording.supabase, 'company-1', settings)
    const rows = recording.getInsertPayload() ?? []
    return {
      supabase: recording.supabase,
      agi: rows
        .filter((row) => row.tax_deadline_type === 'arbetsgivardeklaration')
        .map((row) => `${row.tax_period}:${row.due_date}`),
    }
  }

  it('creates the AGI rows from an active employee with a monthly salary', async () => {
    const { agi } = await agiRows([employee()])

    expect(agi).toContain('2026-10:2026-11-12')
    expect(agi).toContain('2026-11:2026-12-14')
  })

  it('counts an hourly employee with a rate', async () => {
    const { agi } = await agiRows([employee({ monthly_salary: null, hourly_rate: 200 })])

    expect(agi).toContain('2026-11:2026-12-14')
  })

  it('creates no AGI row from an employee who is no longer active', async () => {
    const { agi } = await agiRows([employee({ is_active: false })])

    expect(agi).toEqual([])
  })

  it('creates no AGI row from an active employee without any salary set', async () => {
    const { agi } = await agiRows([employee({ monthly_salary: null, hourly_rate: null })])

    expect(agi).toEqual([])
  })

  it('does not count another company\'s employee', async () => {
    const { agi } = await agiRows([employee({ company_id: 'company-2' })])

    expect(agi).toEqual([])
  })

  it('starts at the first employment month for an employee who has not started yet', async () => {
    const { agi } = await agiRows([employee({ employment_start: '2027-01-15' })])

    expect(agi.length).toBeGreaterThan(0)
    expect(agi.every((key) => key >= '2027-01')).toBe(true)
    expect(agi).toContain('2027-01:2027-02-12')
  })

  it('keeps an explicit "not a registered employer" and never reads the employees', async () => {
    const { agi, supabase } = await agiRows([employee()], { ...UNATTESTED, employer_registered: false })

    expect(agi).toEqual([])
    expect(supabase.from).not.toHaveBeenCalledWith('employees')
  })

  it('does not read the employees when a flag already decides', async () => {
    const { agi, supabase } = await agiRows([], { ...UNATTESTED, pays_salaries: true })

    expect(agi).toContain('2026-11:2026-12-14')
    expect(supabase.from).not.toHaveBeenCalledWith('employees')
  })

  it('carries resolved employee evidence through toDeadlineSettings', () => {
    expect(toDeadlineSettings({ ...UNATTESTED, salaried_employee_since: '2026-03-01' }).salaried_employee_since)
      .toBe('2026-03-01')
  })

  describe('the nightly backfill', () => {
    /**
     * Table-routed mock: paginated reads (.range) answer from `tables`
     * through the eq filters applied; the generator's own deadline reads
     * answer empty; inserts are recorded.
     */
    function makeSupabase(tables: Record<string, Array<Record<string, unknown>>>) {
      const inserts: Array<Array<Record<string, unknown>>> = []
      const from = vi.fn((table: string) => {
        const chain: Record<string, unknown> = {}
        const filters: Array<[string, unknown]> = []
        let deleting = false
        for (const method of ['is', 'gte', 'lte', 'or', 'not', 'order', 'in']) {
          chain[method] = vi.fn(() => chain)
        }
        chain.eq = vi.fn((column: string, value: unknown) => {
          filters.push([column, value])
          return chain
        })
        chain.select = vi.fn(() => (deleting ? Promise.resolve({ data: [], error: null }) : chain))
        chain.range = vi.fn(async () => ({
          data: (tables[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value)),
          error: null,
        }))
        chain.insert = vi.fn((rows: Array<Record<string, unknown>>) => {
          inserts.push(rows)
          return { select: vi.fn(async () => ({ data: rows.map((_, i) => ({ id: `new-${i}` })), error: null })) }
        })
        chain.delete = vi.fn(() => {
          deleting = true
          return chain
        })
        chain.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve)
        return chain
      })
      return { supabase: { from } as unknown as SupabaseClient, inserts }
    }

    function storedRows(companyId: string, settings: CompanySettingsForDeadlines) {
      return Array.from(getExpectedUpcomingDeadlineKeys(settings), (key, index) => {
        const [taxDeadlineType, taxPeriod, dueDate] = key.split(':')
        return {
          id: `${companyId}-${index}`,
          company_id: companyId,
          source: 'system',
          deadline_type: 'tax',
          tax_deadline_type: taxDeadlineType,
          tax_period: taxPeriod,
          due_date: dueDate,
          is_completed: false,
          dismissed_at: null,
        }
      })
    }

    it('adds the AGI rows to the company missing them, once, and leaves the rest alone', async () => {
      const { fiscal_years: _fy, tax_assessment_notices: _tan, ...raw } = UNATTESTED
      // What every company held before the fix: no AGI rows.
      const withoutAgi = { ...UNATTESTED, salaried_employee_since: null }
      const withAgi = { ...UNATTESTED, salaried_employee_since: '2026-03-01' }
      const { supabase, inserts } = makeSupabase({
        company_settings: [
          { company_id: 'company-1', ...raw },
          // Already regenerated: holds the AGI rows the evidence expects.
          { company_id: 'company-2', ...raw },
          // Only an employee who left.
          { company_id: 'company-3', ...raw },
          // Attested as not a registered employer.
          { company_id: 'company-4', ...raw, employer_registered: false },
        ],
        employees: [
          employee({ id: 'e1', company_id: 'company-1' }),
          employee({ id: 'e2', company_id: 'company-2' }),
          employee({ id: 'e3', company_id: 'company-3', is_active: false }),
          employee({ id: 'e4', company_id: 'company-4' }),
        ],
        deadlines: [
          ...storedRows('company-1', withoutAgi),
          ...storedRows('company-2', withAgi),
          ...storedRows('company-3', withoutAgi),
          ...storedRows('company-4', withoutAgi),
        ],
      })

      const result = await backfillMissingTaxDeadlines(supabase)

      expect(result).toMatchObject({ companiesScanned: 4, companiesRepaired: 1 })
      expect(inserts).toHaveLength(1)
      expect(new Set(inserts[0].map((row) => row.company_id))).toEqual(new Set(['company-1']))
      expect(inserts[0].map((row) => `${row.tax_deadline_type}:${row.tax_period}`))
        .toContain('arbetsgivardeklaration:2026-11')
      // One read of the employees for every company, none per company.
      expect((supabase.from as ReturnType<typeof vi.fn>).mock.calls.filter(([table]) => table === 'employees'))
        .toHaveLength(1)
    })
  })
})
