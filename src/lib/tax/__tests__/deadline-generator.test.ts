import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ANNUAL_HORIZON_DAYS,
  RECURRING_HORIZON_DAYS,
  alignYearlyVatDeadlinesWithBooks,
  backfillMissingTaxDeadlines,
  helarsmomsSettledByOpenRows,
  generateNewYearDeadlines,
  findSettingsMissingUpcomingDeadlines,
  findSettingsWithStaleUpcomingDeadlines,
  generateTaxDeadlinesForUser,
  getExpectedUpcomingDeadlineKeys,
  shouldRegenerateTaxDeadlines,
  toDeadlineSettings,
} from '../deadline-generator'
import type { CompanySettingsForDeadlines } from '../deadline-config'
import { createRowsMockSupabase } from '@/tests/helpers'
import { fiscalYearsWithEuTrade } from '../fiscal-year-eu-trade'

// The books' answer on EU trade (one read of a period's declaration each):
// none unless a test says otherwise.
vi.mock('../fiscal-year-eu-trade', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fiscal-year-eu-trade')>()),
  fiscalYearsWithEuTrade: vi.fn(async () => []),
}))

// log.error is what reaches the error tracker: the fallback to two
// statements must be reported, once per process. Other levels stay silent.
const mockLogError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', async (importOriginal) => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockLogError, child: vi.fn() }
  logger.child.mockReturnValue(logger)
  return { ...(await importOriginal<typeof import('@/lib/logger')>()), createLogger: () => logger }
})

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
  due_date?: string | null
  status?: string
  status_changed_at?: string | null
  notes?: string | null
  due_time?: string | null
  priority?: string | null
  customer_id?: string | null
}

/**
 * Recording mock: captures the replacement the generator asks the database
 * for (replace_system_tax_deadlines: the new rows and the window, one call)
 * and its rows. With `functionMissing` the database answers as one that does
 * not have the function yet, and the mock records the order of the two
 * statements the generator then falls back to (insert first, delete after),
 * the ordering that keeps a failed insert from wiping deadlines.
 */
function makeRecordingSupabase(opts: {
  /** The replacement (or, with functionMissing, the insert) fails with this. */
  insertError?: { code: string; message: string }
  /** The database has no replace_system_tax_deadlines yet (PGRST202). */
  functionMissing?: boolean
  /** The function exists but fails with this error. */
  replaceError?: { code: string; message: string }
  completedRows?: Array<{ tax_deadline_type: string; tax_period: string }>
  supersededRows?: SupersededRow[]
  fiscalPeriods?: Array<{ company_id: string; period_start: string; period_end: string }>
  /** The AGI filing records, answered through the filters the generator applies. */
  agiKvittenser?: Array<Record<string, unknown>>
  agiDeclarations?: Array<Record<string, unknown>>
  /** employees rows, answered through the filters the generator applies. */
  employees?: Array<Record<string, unknown>>
  /** vat_eu_trade_fiscal_years rows: the years the nightly pass saw EU trade in. */
  euTradeYears?: Array<{ company_id: string; fiscal_year_end: string }>
  /** The read of vat_eu_trade_fiscal_years fails with this. */
  euTradeYearsError?: { code: string; message: string }
} = {}) {
  const calls: string[] = []
  /** The .or() filters of the fallback's delete, as PostgREST receives them. */
  const deleteOrFilters: string[] = []
  let insertPayload: Array<Record<string, unknown>> | null = null
  let replaceArgs: Record<string, unknown> | null = null
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name !== 'replace_system_tax_deadlines') return { data: null, error: null }
    if (opts.functionMissing) return { data: null, error: { code: 'PGRST202', message: 'function not found' } }
    calls.push('replace')
    if (opts.replaceError) return { data: null, error: opts.replaceError }
    replaceArgs = args
    insertPayload = args.p_rows as Array<Record<string, unknown>>
    return opts.insertError
      ? { data: null, error: opts.insertError }
      : { data: [{ created: insertPayload.length, deleted: 2 }], error: null }
  })
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
    if (table === 'vat_eu_trade_fiscal_years') {
      // The years the nightly pass recorded (paginated).
      const years: Record<string, ReturnType<typeof vi.fn>> = {}
      years.select = vi.fn(() => years)
      years.eq = vi.fn(() => years)
      years.order = vi.fn(() => years)
      years.range = vi.fn(async () =>
        opts.euTradeYearsError
          ? { data: null, error: opts.euTradeYearsError }
          : { data: opts.euTradeYears ?? [], error: null },
      )
      return years
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
    chain.or = vi.fn((filter: string) => {
      if (isDelete) deleteOrFilters.push(filter)
      else isCompletedQuery = true
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
    supabase: { from, rpc } as unknown as SupabaseClient,
    calls,
    deleteOrFilters,
    getInsertPayload: () => insertPayload,
    getReplaceArgs: () => replaceArgs,
  }
}

/**
 * Table-routed mock: paginated reads (.range) answer from `tables`
 * through the eq filters applied; the generator's own deadline reads
 * answer empty; inserts and upserts are recorded.
 */
function makeSupabase(
  tables: Record<string, Array<Record<string, unknown>>>,
  /** A paginated read of these tables fails with the error given. */
  errors: Record<string, { code: string; message: string }> = {},
) {
  const inserts: Array<Array<Record<string, unknown>>> = []
  const upserts: Array<{ table: string; rows: Array<Record<string, unknown>>; options?: Record<string, unknown> }> = []
  const updates: Array<{ table: string; row: Record<string, unknown>; filters: Array<[string, unknown]> }> = []
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    const filters: Array<[string, unknown]> = []
    let deleting = false
    for (const method of ['is', 'gte', 'lte', 'not', 'order', 'in']) {
      chain[method] = vi.fn(() => chain)
    }
    chain.or = vi.fn((filter: string) => {
      orFilter = filter
      return chain
    })
    chain.eq = vi.fn((column: string, value: unknown) => {
      filters.push([column, value])
      return chain
    })
    chain.select = vi.fn(() => (deleting ? Promise.resolve({ data: [], error: null }) : chain))
    // A page (.range) answers from the table through every eq filter, those
    // chained after .range too, as PostgREST's builder allows. The
    // generator's own reads of a company's deadlines (no .range) answer its
    // open rows, or with .or() its completed and dismissed ones.
    let paged = false
    let orFilter: string | null = null
    chain.range = vi.fn(() => {
      paged = true
      return chain
    })
    chain.insert = vi.fn((rows: Array<Record<string, unknown>>) => {
      inserts.push(rows)
      return { select: vi.fn(async () => ({ data: rows.map((_, i) => ({ id: `new-${i}` })), error: null })) }
    })
    chain.upsert = vi.fn(async (rows: Array<Record<string, unknown>>, options?: Record<string, unknown>) => {
      upserts.push({ table, rows, options })
      return { data: null, error: null }
    })
    chain.update = vi.fn((row: Record<string, unknown>) => {
      updates.push({ table, row, filters })
      return chain
    })
    chain.delete = vi.fn(() => {
      deleting = true
      return chain
    })
    const ownDeadlines = () => {
      const rows = (tables.deadlines ?? []).filter((row) =>
        filters.every(([column, value]) => row[column] === value),
      )
      return orFilter
        ? rows.filter((row) => row.is_completed === true || (row.dismissed_at ?? null) !== null)
        : rows.filter((row) => (row.dismissed_at ?? null) === null)
    }
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        !paged
          ? { data: table === 'deadlines' && !deleting ? ownDeadlines() : [], error: null }
          : errors[table]
            ? { data: null, error: errors[table] }
            : {
                data: (tables[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value)),
                error: null,
              },
      ).then(resolve)
    return chain
  })
  // The replacement of a company's set (replace_system_tax_deadlines).
  const rpc = vi.fn(async (_name: string, args: { p_rows: Array<Record<string, unknown>> }) => {
    if (args.p_rows.length > 0) inserts.push(args.p_rows)
    return { data: [{ created: args.p_rows.length, deleted: 0 }], error: null }
  })
  return { supabase: { from, rpc } as unknown as SupabaseClient, inserts, upserts, updates }
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('generateTaxDeadlinesForUser', () => {
  it('replaces the set in one database call: the rows, the company and the window', async () => {
    const { supabase, calls, getReplaceArgs, getInsertPayload } = makeRecordingSupabase()

    const result = await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)

    // One call, so the insert and the delete cannot interleave with another
    // regeneration's: no separate insert or delete reaches the table.
    expect(calls).toEqual(['replace'])
    expect(getReplaceArgs()).toEqual({
      p_company_id: 'company-1',
      p_rows: getInsertPayload(),
      p_from: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date()),
      p_to: `${Math.max(...GEN_YEARS) + 1}-12-31`,
    })
    expect(result.created).toBe(getInsertPayload()!.length)
    expect(result.created).toBeGreaterThan(0)
    expect(result.deleted).toBe(2)
  })

  it('a failed replacement throws and deletes nothing', async () => {
    const { supabase, calls } = makeRecordingSupabase({
      insertError: { code: '23502', message: 'null value in column "user_id"' },
    })

    await expect(
      generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)
    ).rejects.toMatchObject({ code: '23502' })

    // No fallback for a real error: the two statements are only for a
    // database without the function.
    expect(calls).toEqual(['replace'])
  })

  it('42883 from the function is a failure, never a reason to run the unsafe two statements', async () => {
    // Postgres answers 42883 for a function or operator it cannot resolve
    // inside the body or a trigger it fires: the function is there and broke.
    const { supabase, calls } = makeRecordingSupabase({
      replaceError: { code: '42883', message: 'operator does not exist: uuid = text' },
    })

    await expect(
      generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)
    ).rejects.toMatchObject({ code: '42883' })

    expect(calls).toEqual(['replace'])
  })

  describe('before the database has replace_system_tax_deadlines (the deploy window)', () => {
    it('falls back only on PGRST202, and says so as an error once per process', async () => {
      // A fresh module: the report is once per process, and earlier tests in
      // this file may already have made it.
      vi.resetModules()
      const fresh = await import('../deadline-generator')
      mockLogError.mockClear()

      for (let run = 0; run < 2; run++) {
        const { supabase, calls } = makeRecordingSupabase({ functionMissing: true })
        await fresh.generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)
        expect(calls[0]).toBe('insert')
      }

      const fallbackReports = mockLogError.mock.calls.filter(([message]) =>
        String(message).includes('replace_system_tax_deadlines is not in the database'),
      )
      expect(fallbackReports).toHaveLength(1)
    })

    it('inserts replacement rows before deleting the old set', async () => {
      const { supabase, calls } = makeRecordingSupabase({ functionMissing: true })

      const result = await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)

      expect(calls[0]).toBe('insert')
      expect(calls[1]).toBe('delete')
      expect(result.created).toBeGreaterThan(0)
      expect(result.deleted).toBe(2)
    })

    it('excludes the newly inserted rows from the delete', async () => {
      const { supabase, calls } = makeRecordingSupabase({ functionMissing: true })

      await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)

      expect(calls.some((c) => c.startsWith('not('))).toBe(true)
    })

    it('deletes the old rows of a notice already past due, not only the window (crm#2084)', async () => {
      // A notice's kvarskatt is written even after its payment date, and its
      // old row lies before the window: the delete must reach it, or every
      // regeneration adds one more.
      const due = new Date()
      due.setDate(due.getDate() - 10)
      const paymentDueDate = [
        due.getFullYear(),
        String(due.getMonth() + 1).padStart(2, '0'),
        String(due.getDate()).padStart(2, '0'),
      ].join('-')
      const { supabase, deleteOrFilters, getInsertPayload } = makeRecordingSupabase({ functionMissing: true })

      await generateTaxDeadlinesForUser(supabase, 'company-1', {
        ...SETTINGS,
        tax_assessment_notices: [{ id: 'notice-1', fiscalPeriodName: '2025', decisionType: 'final', paymentDueDate }],
      }, [])

      expect(getInsertPayload()).toContainEqual(expect.objectContaining({
        tax_period: 'notice:notice-1',
        due_date: paymentDueDate,
      }))
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
      // The whole filter: the notice condition stands beside the window, not
      // inside it. With no years given the window ends two years ahead.
      const windowEnd = `${Number(today.slice(0, 4)) + 2}-12-31`
      expect(deleteOrFilters).toEqual([
        `and(due_date.gte.${today},due_date.lte.${windowEnd}),tax_assessment_notice_id.in.(notice-1)`,
      ])
    })

    it('does not delete existing deadlines when the insert fails', async () => {
      const { supabase, calls } = makeRecordingSupabase({
        functionMissing: true,
        insertError: { code: '23502', message: 'null value in column "user_id"' },
      })

      await expect(
        generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, GEN_YEARS)
      ).rejects.toMatchObject({ code: '23502' })

      expect(calls).toContain('insert')
      expect(calls).not.toContain('delete')
    })
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

    describe('inside a time budget', () => {
      // Three companies that all miss their AGI rows, as on the night a due
      // date enters the horizon for everyone at once.
      function threeCompaniesToRepair() {
        const { fiscal_years: _fy, tax_assessment_notices: _tan, ...raw } = UNATTESTED
        const withoutAgi = { ...UNATTESTED, salaried_employee_since: null }
        return makeSupabase({
          company_settings: ['company-1', 'company-2', 'company-3'].map((company_id) => ({ company_id, ...raw })),
          employees: ['company-1', 'company-2', 'company-3'].map((company_id, i) =>
            employee({ id: `e${i}`, company_id }),
          ),
          deadlines: ['company-1', 'company-2', 'company-3'].flatMap((id) => storedRows(id, withoutAgi)),
        })
      }

      it('repairs every flagged company when there is time', async () => {
        const { supabase, inserts } = threeCompaniesToRepair()

        const result = await backfillMissingTaxDeadlines(supabase, { deadline: Date.now() + 60_000 })

        expect(result).toMatchObject({ companiesRepaired: 3, companiesNotReached: 0 })
        expect(inserts).toHaveLength(3)
      })

      it('starts no repair after the deadline and counts the companies left for the next run', async () => {
        const { supabase, inserts } = threeCompaniesToRepair()
        // The first repair takes the run past its deadline.
        const now = vi.spyOn(Date, 'now')
        const start = Date.now()
        ;(supabase.rpc as ReturnType<typeof vi.fn>).mockImplementationOnce(
          async (_name: string, args: { p_rows: Array<Record<string, unknown>> }) => {
            inserts.push(args.p_rows)
            now.mockReturnValue(start + 10_000)
            return { data: [{ created: args.p_rows.length, deleted: 0 }], error: null }
          },
        )

        const result = await backfillMissingTaxDeadlines(supabase, { deadline: start + 5_000 })
        now.mockRestore()

        expect(result).toMatchObject({ companiesScanned: 3, companiesRepaired: 1, companiesNotReached: 2 })
        // Nothing was written for the two left: they still miss their rows,
        // which is what makes the next run find them.
        expect(inserts).toHaveLength(1)
        expect(new Set(inserts[0].map((row) => row.company_id))).toEqual(new Set(['company-1']))
      })

      it('the new-year pass stops the same way', async () => {
        const { supabase, inserts } = threeCompaniesToRepair()
        const now = vi.spyOn(Date, 'now')
        const start = Date.now()
        ;(supabase.rpc as ReturnType<typeof vi.fn>).mockImplementationOnce(
          async (_name: string, args: { p_rows: Array<Record<string, unknown>> }) => {
            inserts.push(args.p_rows)
            now.mockReturnValue(start + 10_000)
            return { data: [{ created: args.p_rows.length, deleted: 0 }], error: null }
          },
        )

        const result = await generateNewYearDeadlines(supabase, { deadline: start + 5_000 })
        now.mockRestore()

        expect(result).toMatchObject({ usersProcessed: 1, companiesNotReached: 2 })
        expect(inserts).toHaveLength(1)
      })
    })
  })
})

describe('helårsmoms follows the EU trade recorded from the books', () => {
  // An enskild firma, helårsmoms, the setting "Handel med andra EU-länder"
  // off, on 14 November 2026. Without EU trade its 2026 VAT is due with the
  // income return (12 May 2027), with EU trade on 26 February 2027.
  const EF_YEARLY: CompanySettingsForDeadlines = {
    ...SETTINGS,
    entity_type: 'enskild_firma',
    moms_period: 'yearly',
    pays_salaries: false,
    preliminary_tax_monthly: null,
    fiscal_years: [],
    tax_assessment_notices: [],
    salaried_employee_since: null,
  }
  // An aktiebolag whose räkenskapsår ends in October: with EU trade its
  // helårsmoms is due on 26 December 2026 (a Saturday, so 28 December), a
  // calendar year before the date without it.
  const AB_OCTOBER: CompanySettingsForDeadlines = {
    ...SETTINGS,
    moms_period: 'yearly',
    pays_salaries: false,
    fiscal_year_start_month: 11,
    fiscal_years: [{ start: '2025-11-01', end: '2026-10-31' }],
    tax_assessment_notices: [],
    salaried_employee_since: null,
  }
  const booksRead = vi.mocked(fiscalYearsWithEuTrade)
  const key = (period: { endYear: number; endMonth: number }) => `${period.endYear}-${String(period.endMonth).padStart(2, '0')}`
  /** The books: each company's periods with EU trade, answered from the periods actually read. */
  const booksWithTrade = (trade: Record<string, string[]>) =>
    booksRead.mockImplementation(async (_supabase, companyId, periods) =>
      periods.map(key).filter((k) => (trade[companyId] ?? []).includes(k)),
    )
  const periodsRead = () => booksRead.mock.calls.map(([, companyId, periods]) => `${companyId}:${periods.map(key).join(',')}`)
  const yearly = (rows: Array<Record<string, unknown>> | null | undefined) =>
    (rows ?? []).filter((row) => row.tax_deadline_type === 'moms_yearly').map((row) => `${row.tax_period}:${row.due_date}`)
  const recordedFor = (companyId: string, ...keys: string[]) =>
    keys.map((fiscal_year_end) => ({ company_id: companyId, fiscal_year_end, has_eu_trade: true, checked_at: '2026-11-01T02:00:00.000Z' }))
  const readWithout = (companyId: string, fiscal_year_end: string, checked_at: string) => ({
    company_id: companyId,
    fiscal_year_end,
    has_eu_trade: false,
    checked_at,
  })
  const yearsReads = (supabase: SupabaseClient) =>
    (supabase.from as ReturnType<typeof vi.fn>).mock.calls.filter(([table]) => table === 'vat_eu_trade_fiscal_years')

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 14, 12))
  })

  afterEach(() => {
    booksRead.mockImplementation(async () => [])
    vi.useRealTimers()
  })

  describe('the generator', () => {
    it('dates a period recorded with EU trade by the earlier date', async () => {
      const { supabase, getInsertPayload } = makeRecordingSupabase({ euTradeYears: recordedFor('company-1', '2026-12') })

      await generateTaxDeadlinesForUser(supabase, 'company-1', EF_YEARLY)

      expect(yearly(getInsertPayload())).toEqual(['2026:2027-02-26'])
    })

    it('keeps the date of the setting when nothing is recorded', async () => {
      const { supabase, getInsertPayload } = makeRecordingSupabase()

      await generateTaxDeadlinesForUser(supabase, 'company-1', EF_YEARLY)

      expect(yearly(getInsertPayload())).toEqual(['2026:2027-05-12'])
    })

    it('never reads the books itself', async () => {
      const { supabase } = makeRecordingSupabase({ euTradeYears: recordedFor('company-1', '2026-12') })

      await generateTaxDeadlinesForUser(supabase, 'company-1', EF_YEARLY)

      expect(booksRead).not.toHaveBeenCalled()
    })

    it('reads no recorded periods when the setting says EU trade or the company files monthly', async () => {
      const { supabase } = makeRecordingSupabase({ euTradeYears: recordedFor('company-1', '2026-12') })

      await generateTaxDeadlinesForUser(supabase, 'company-1', { ...EF_YEARLY, vat_has_eu_trade: true })
      await generateTaxDeadlinesForUser(supabase, 'company-1', { ...EF_YEARLY, moms_period: 'monthly' })

      expect(yearsReads(supabase)).toEqual([])
    })

    it('keeps the date of the setting while the table is not in the database yet', async () => {
      const { supabase, getInsertPayload } = makeRecordingSupabase({
        euTradeYearsError: { code: 'PGRST205', message: "Could not find the table 'public.vat_eu_trade_fiscal_years'" },
      })

      await generateTaxDeadlinesForUser(supabase, 'company-1', EF_YEARLY)

      expect(yearly(getInsertPayload())).toEqual(['2026:2027-05-12'])
    })

    it('replaces nothing when the recorded periods cannot be read', async () => {
      const { supabase, calls } = makeRecordingSupabase({
        euTradeYearsError: { code: '57014', message: 'canceling statement due to statement timeout' },
      })

      await expect(generateTaxDeadlinesForUser(supabase, 'company-1', EF_YEARLY)).rejects.toThrow(/statement timeout/)
      expect(calls).not.toContain('replace')
    })

    it('keys an enskild firma on recorded broken years by the calendar year it declares', async () => {
      const { supabase, getInsertPayload } = makeRecordingSupabase({ euTradeYears: recordedFor('company-1', '2026-12') })

      await generateTaxDeadlinesForUser(supabase, 'company-1', {
        ...EF_YEARLY,
        fiscal_years: [
          { start: '2025-09-01', end: '2026-08-31' },
          { start: '2026-09-01', end: '2027-08-31' },
        ],
      })

      expect(yearly(getInsertPayload())).toEqual(['2026:2027-02-26'])
    })

    it('moves a period whose EU-trade date falls in the calendar year before its later date', async () => {
      const without = makeRecordingSupabase()
      await generateTaxDeadlinesForUser(without.supabase, 'company-1', AB_OCTOBER)
      const later = yearly(without.getInsertPayload()).filter((row) => row.startsWith('2025/2026:'))
      expect(later).toHaveLength(1)
      expect(later[0] > '2025/2026:2027').toBe(true)

      const { supabase, getInsertPayload } = makeRecordingSupabase({ euTradeYears: recordedFor('company-1', '2026-10') })
      await generateTaxDeadlinesForUser(supabase, 'company-1', AB_OCTOBER)

      expect(yearly(getInsertPayload()).filter((row) => row.startsWith('2025/2026:'))).toEqual(['2025/2026:2026-12-28'])
    })

    describe('once a recorded period\'s earlier date has passed', () => {
      beforeEach(() => {
        vi.setSystemTime(new Date(2027, 2, 1, 12))
      })

      it('keeps its open row on the later date instead of replacing it by none', async () => {
        // Recorded, but the row was never moved: a failed regeneration, a row
        // filed and then unmarked, a revert.
        const { supabase, getInsertPayload } = makeRecordingSupabase({
          euTradeYears: recordedFor('company-1', '2026-12'),
          supersededRows: [{ tax_deadline_type: 'moms_yearly', tax_period: '2026', due_date: '2027-05-12' }],
        })

        await generateTaxDeadlinesForUser(supabase, 'company-1', EF_YEARLY)

        expect(yearly(getInsertPayload())).toContain('2026:2027-05-12')
      })

      it('writes no second row when its row is on the earlier date', async () => {
        const { supabase, getInsertPayload } = makeRecordingSupabase({
          euTradeYears: recordedFor('company-1', '2026-12'),
          supersededRows: [{ tax_deadline_type: 'moms_yearly', tax_period: '2026', due_date: '2027-02-26', status: 'overdue' }],
        })

        await generateTaxDeadlinesForUser(supabase, 'company-1', EF_YEARLY)

        // The replacement ran and wrote no 2026 row.
        expect(getInsertPayload()).not.toBeNull()
        expect(yearly(getInsertPayload()).filter((row) => row.startsWith('2026:'))).toEqual([])
      })

      it('keeps a later row when the setting is turned on after the earlier date', async () => {
        const { supabase, getInsertPayload } = makeRecordingSupabase({
          supersededRows: [{ tax_deadline_type: 'moms_yearly', tax_period: '2026', due_date: '2027-05-12' }],
        })

        await generateTaxDeadlinesForUser(supabase, 'company-1', { ...EF_YEARLY, vat_has_eu_trade: true })

        expect(yearly(getInsertPayload())).toContain('2026:2027-05-12')
      })

      it('adds no later row when the setting is turned off after the earlier date', async () => {
        const { supabase, getInsertPayload } = makeRecordingSupabase({
          supersededRows: [{ tax_deadline_type: 'moms_yearly', tax_period: '2026', due_date: '2027-02-26', status: 'overdue' }],
        })

        await generateTaxDeadlinesForUser(supabase, 'company-1', EF_YEARLY)

        // The replacement ran and wrote no 2026 row.
        expect(getInsertPayload()).not.toBeNull()
        expect(yearly(getInsertPayload()).filter((row) => row.startsWith('2026:'))).toEqual([])
      })
    })

    it('keeps the row ahead of a period that already has one next to an overdue row', async () => {
      // What turning the setting off after the earlier date left before this rule.
      vi.setSystemTime(new Date(2027, 2, 5, 12))
      const { supabase, getInsertPayload } = makeRecordingSupabase({
        supersededRows: [
          { tax_deadline_type: 'moms_yearly', tax_period: '2026', due_date: '2027-02-26', status: 'overdue' },
          { tax_deadline_type: 'moms_yearly', tax_period: '2026', due_date: '2027-05-12' },
        ],
      })

      await generateTaxDeadlinesForUser(supabase, 'company-1', EF_YEARLY)

      expect(yearly(getInsertPayload())).toContain('2026:2027-05-12')
    })

    it('settles an enskild firma whose broken years were re-laid to the calendar year', () => {
      vi.setSystemTime(new Date(2027, 1, 27, 12))
      const relaidEf: CompanySettingsForDeadlines = {
        ...EF_YEARLY,
        fiscal_years: [
          { start: '2025-09-01', end: '2026-08-31' },
          { start: '2026-09-01', end: '2026-12-31' },
        ],
      }
      const openRows = [{ tax_deadline_type: 'moms_yearly', tax_period: '2026', due_date: '2027-05-12' }]

      expect(helarsmomsSettledByOpenRows(relaidEf, openRows, '2027-02-27')).toEqual({ '2026-12': false })
    })

    it('leaves a label two räkenskapsår share to the plain answer', () => {
      vi.setSystemTime(new Date(2027, 9, 27, 12))
      const relaid: CompanySettingsForDeadlines = {
        ...SETTINGS,
        moms_period: 'yearly',
        fiscal_year_start_month: 9,
        fiscal_years: [
          { start: '2026-03-01', end: '2027-02-28' },
          { start: '2027-03-01', end: '2027-08-31' },
        ],
      }
      const openRows = [{ tax_deadline_type: 'moms_yearly', tax_period: '2026/2027', due_date: '2027-10-26' }]

      expect(helarsmomsSettledByOpenRows(relaid, openRows, '2027-10-27')).toBeUndefined()
    })
  })

  describe('the nightly repair', () => {
    const { fiscal_years: _fy, tax_assessment_notices: _tan, salaried_employee_since: _since, ...raw } = EF_YEARLY
    const settingsRow = { company_id: 'company-1', ...raw }
    const recorded = { ...EF_YEARLY, eu_trade_fiscal_year_ends: ['2026-12'] }
    const withRecord = { ...settingsRow, eu_trade_fiscal_year_ends: ['2026-12'] }

    it('expects the recorded date, so a row on the later date is missing and stale', () => {
      const later = storedRows('company-1', EF_YEARLY)

      expect(findSettingsMissingUpcomingDeadlines([withRecord], later)).toEqual([withRecord])
      expect(findSettingsWithStaleUpcomingDeadlines([withRecord], later)).toEqual([withRecord])
      expect(findSettingsMissingUpcomingDeadlines([withRecord], storedRows('company-1', recorded))).toEqual([])
      expect(findSettingsWithStaleUpcomingDeadlines([withRecord], storedRows('company-1', recorded))).toEqual([])
    })

    it('leaves a recorded period\'s later row alone once the earlier date has passed', () => {
      vi.setSystemTime(new Date(2027, 1, 27, 12))
      const later = storedRows('company-1', EF_YEARLY)
      expect(yearly(later)).toContain('2026:2027-05-12')

      expect(findSettingsMissingUpcomingDeadlines([withRecord], later)).toEqual([])
      expect(findSettingsWithStaleUpcomingDeadlines([withRecord], later)).toEqual([])
    })

    it('moves the row once and then leaves the company alone', async () => {
      const first = makeSupabase({
        company_settings: [settingsRow],
        deadlines: storedRows('company-1', EF_YEARLY),
        vat_eu_trade_fiscal_years: recordedFor('company-1', '2026-12'),
      })

      expect(await backfillMissingTaxDeadlines(first.supabase)).toMatchObject({ companiesRepaired: 1 })
      expect(yearly(first.inserts[0])).toEqual(['2026:2027-02-26'])

      const second = makeSupabase({
        company_settings: [settingsRow],
        deadlines: storedRows('company-1', recorded),
        vat_eu_trade_fiscal_years: recordedFor('company-1', '2026-12'),
      })
      expect(await backfillMissingTaxDeadlines(second.supabase)).toMatchObject({ companiesRepaired: 0 })
      expect(booksRead).not.toHaveBeenCalled()
    })

    it('leaves the period\'s row alone when the setting changes after the earlier date', () => {
      vi.setSystemTime(new Date(2027, 2, 5, 12))
      // Turned off after 26 February: the row stays on that date, overdue.
      const turnedOff = storedRows('company-1', EF_YEARLY).map((row) =>
        row.tax_deadline_type === 'moms_yearly' && row.tax_period === '2026' ? { ...row, due_date: '2027-02-26' } : row,
      )
      expect(findSettingsMissingUpcomingDeadlines([settingsRow], turnedOff)).toEqual([])
      expect(findSettingsWithStaleUpcomingDeadlines([settingsRow], turnedOff)).toEqual([])

      // Turned on after 26 February: the row stays on 12 May.
      const on = { ...settingsRow, vat_has_eu_trade: true }
      const turnedOn = [
        ...storedRows('company-1', { ...EF_YEARLY, vat_has_eu_trade: true }),
        { ...storedRows('company-1', EF_YEARLY).find((row) => row.tax_period === '2026')!, id: 'company-1-later' },
      ]
      expect(yearly(turnedOn)).toContain('2026:2027-05-12')
      expect(findSettingsMissingUpcomingDeadlines([on], turnedOn)).toEqual([])
      expect(findSettingsWithStaleUpcomingDeadlines([on], turnedOn)).toEqual([])
    })

    it('leaves a period alone that already has a row ahead next to an overdue one', () => {
      vi.setSystemTime(new Date(2027, 2, 5, 12))
      const pair = [
        ...storedRows('company-1', EF_YEARLY),
        {
          ...storedRows('company-1', EF_YEARLY).find((row) => row.tax_period === '2026')!,
          id: 'company-1-overdue',
          due_date: '2027-02-26',
        },
      ]
      expect(yearly(pair).filter((row) => row.startsWith('2026:')).sort()).toEqual(['2026:2027-02-26', '2026:2027-05-12'])

      expect(findSettingsMissingUpcomingDeadlines([settingsRow], pair)).toEqual([])
      expect(findSettingsWithStaleUpcomingDeadlines([settingsRow], pair)).toEqual([])
    })

    it('keeps that row when the repair regenerates the company for another reason', async () => {
      vi.setSystemTime(new Date(2027, 2, 5, 12))
      const on = { ...settingsRow, vat_has_eu_trade: true }
      const rows = [
        ...storedRows('company-1', { ...EF_YEARLY, vat_has_eu_trade: true }),
        { ...storedRows('company-1', EF_YEARLY).find((row) => row.tax_period === '2026')!, id: 'company-1-later' },
      ]
      // Another obligation's row is missing: the company is regenerated.
      const other = rows.find((row) => row.tax_deadline_type !== 'moms_yearly')!
      expect(other).toBeDefined()
      const missingOne = rows.filter((row) => row !== other)
      const { supabase, inserts } = makeSupabase({ company_settings: [on], deadlines: missingOne })

      expect(await backfillMissingTaxDeadlines(supabase)).toMatchObject({ companiesRepaired: 1 })
      expect(yearly(inserts[0])).toContain('2026:2027-05-12')
    })

    it('never deletes the later row of a period recorded too late to move it', async () => {
      vi.setSystemTime(new Date(2027, 1, 27, 12))
      const { supabase, inserts } = makeSupabase({
        company_settings: [settingsRow],
        deadlines: storedRows('company-1', EF_YEARLY),
        vat_eu_trade_fiscal_years: recordedFor('company-1', '2026-12'),
      })

      expect(await backfillMissingTaxDeadlines(supabase)).toMatchObject({ companiesRepaired: 0 })
      expect(inserts).toEqual([])
    })
  })

  describe('the nightly pass', () => {
    const { fiscal_years: _fy, tax_assessment_notices: _tan, salaried_employee_since: _since, ...raw } = EF_YEARLY

    it('records what it read for each company and moves the row of the one with EU trade', async () => {
      booksWithTrade({ 'company-1': ['2026-12'] })
      const { supabase, inserts, upserts, updates } = makeSupabase({
        company_settings: [
          { company_id: 'company-1', ...raw },
          { company_id: 'company-2', ...raw },
          // The setting says EU trade: nothing for the books to move.
          { company_id: 'company-3', ...raw, vat_has_eu_trade: true },
        ],
        deadlines: ['company-1', 'company-2', 'company-3'].flatMap((id) => storedRows(id, EF_YEARLY)),
      })

      const result = await alignYearlyVatDeadlinesWithBooks(supabase)

      expect(result).toEqual({ companiesChecked: 2, companiesMoved: 1, companiesNotReached: 0 })
      expect(periodsRead().sort()).toEqual(['company-1:2026-12', 'company-2:2026-12'])
      expect(upserts).toEqual([
        {
          table: 'vat_eu_trade_fiscal_years',
          rows: [{ company_id: 'company-1', fiscal_year_end: '2026-12', has_eu_trade: true, checked_at: expect.any(String) }],
          options: { onConflict: 'company_id,fiscal_year_end' },
        },
        {
          table: 'vat_eu_trade_fiscal_years',
          rows: [{ company_id: 'company-2', fiscal_year_end: '2026-12', has_eu_trade: false, checked_at: expect.any(String) }],
          options: { onConflict: 'company_id,fiscal_year_end', ignoreDuplicates: true },
        },
      ])
      // A read without EU trade only touches rows that say no.
      expect(updates).toHaveLength(1)
      expect(updates[0].filters).toEqual(
        expect.arrayContaining([['company_id', 'company-2'], ['has_eu_trade', false]]),
      )
      expect(inserts).toHaveLength(1)
      expect(new Set(inserts[0].map((row) => row.company_id))).toEqual(new Set(['company-1']))
      expect(yearly(inserts[0])).toEqual(['2026:2027-02-26'])
    })

    it('reads only the periods still open: started, not recorded, EU-trade date ahead', async () => {
      const { supabase } = makeSupabase({ company_settings: [{ company_id: 'company-1', ...raw }] })

      await alignYearlyVatDeadlinesWithBooks(supabase)

      // 2025 was due by 26 February 2026 with EU trade: passed. 2027 has not started.
      expect(periodsRead()).toEqual(['company-1:2026-12'])
      expect(booksRead.mock.calls[0][2]).toEqual([{ endYear: 2026, endMonth: 12, start: '2026-01-01' }])
    })

    it('does not read a period already recorded', async () => {
      const { supabase, inserts } = makeSupabase({
        company_settings: [{ company_id: 'company-1', ...raw }],
        vat_eu_trade_fiscal_years: recordedFor('company-1', '2026-12'),
      })

      const result = await alignYearlyVatDeadlinesWithBooks(supabase)

      expect(result).toEqual({ companiesChecked: 0, companiesMoved: 0, companiesNotReached: 0 })
      expect(booksRead).not.toHaveBeenCalled()
      expect(inserts).toEqual([])
    })

    it('reads a period on its EU-trade date and moves the row to that day', async () => {
      vi.setSystemTime(new Date(2027, 1, 26, 12))
      booksWithTrade({ 'company-1': ['2026-12'] })
      const { supabase, inserts } = makeSupabase({
        company_settings: [{ company_id: 'company-1', ...raw }],
        deadlines: storedRows('company-1', EF_YEARLY),
      })

      const result = await alignYearlyVatDeadlinesWithBooks(supabase)

      expect(result).toMatchObject({ companiesMoved: 1 })
      expect(yearly(inserts[0])).toEqual(['2026:2027-02-26'])
    })

    it('takes the companies read longest ago first, never read before all', async () => {
      const { supabase } = makeSupabase({
        company_settings: ['company-a', 'company-b', 'company-c'].map((company_id) => ({ company_id, ...raw })),
        vat_eu_trade_fiscal_years: [
          readWithout('company-a', '2026-12', '2026-11-13T02:00:00.000Z'),
          readWithout('company-b', '2026-12', '2026-11-01T02:00:00.000Z'),
        ],
      })

      await alignYearlyVatDeadlinesWithBooks(supabase)

      expect(periodsRead()).toEqual(['company-c:2026-12', 'company-b:2026-12', 'company-a:2026-12'])
    })

    it('records an aktiebolag year whose EU-trade date falls in the calendar year before its later date', async () => {
      const { fiscal_years: _years, tax_assessment_notices: _n, salaried_employee_since: _s, ...abRaw } = AB_OCTOBER
      booksWithTrade({ 'company-1': ['2026-10'] })
      const { supabase, inserts, upserts } = makeSupabase({
        company_settings: [{ company_id: 'company-1', ...abRaw }],
        fiscal_periods: [{ company_id: 'company-1', period_start: '2025-11-01', period_end: '2026-10-31' }],
        deadlines: storedRows('company-1', AB_OCTOBER),
      })

      const result = await alignYearlyVatDeadlinesWithBooks(supabase)

      expect(result).toMatchObject({ companiesMoved: 1 })
      // The year that ended and the one running since 1 November.
      expect(periodsRead()).toEqual(['company-1:2026-10,2027-10'])
      expect(upserts.map((upsert) => upsert.rows.map((row) => `${row.fiscal_year_end}:${row.has_eu_trade}`))).toEqual([
        ['2026-10:true'],
        ['2027-10:false'],
      ])
      expect(yearly(inserts[0]).filter((row) => row.startsWith('2025/2026:'))).toEqual(['2025/2026:2026-12-28'])
    })

    it('counts a company whose read fails as read, so it does not go first every night', async () => {
      booksRead.mockImplementation(async () => {
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
      })
      const { supabase, upserts, updates } = makeSupabase({ company_settings: [{ company_id: 'company-1', ...raw }] })

      const result = await alignYearlyVatDeadlinesWithBooks(supabase)

      expect(result).toEqual({ companiesChecked: 1, companiesMoved: 0, companiesNotReached: 0 })
      expect(upserts).toEqual([
        {
          table: 'vat_eu_trade_fiscal_years',
          rows: [{ company_id: 'company-1', fiscal_year_end: '2026-12', has_eu_trade: false, checked_at: expect.any(String) }],
          options: { onConflict: 'company_id,fiscal_year_end', ignoreDuplicates: true },
        },
      ])
      expect(updates[0].filters).toEqual(expect.arrayContaining([['has_eu_trade', false]]))
    })

    it('does nothing while the table is not in the database yet', async () => {
      const { supabase, upserts } = makeSupabase(
        { company_settings: [{ company_id: 'company-1', ...raw }] },
        { vat_eu_trade_fiscal_years: { code: '42P01', message: 'relation "public.vat_eu_trade_fiscal_years" does not exist' } },
      )

      const result = await alignYearlyVatDeadlinesWithBooks(supabase)

      expect(result).toEqual({ companiesChecked: 0, companiesMoved: 0, companiesNotReached: 0 })
      expect(booksRead).not.toHaveBeenCalled()
      expect(upserts).toEqual([])
    })

    it('reads nothing when its budget is already spent', async () => {
      const { supabase } = makeSupabase({ company_settings: [{ company_id: 'company-1', ...raw }] })

      const result = await alignYearlyVatDeadlinesWithBooks(supabase, { deadline: Date.now() - 1 })

      expect(result).toEqual({ companiesChecked: 0, companiesMoved: 0, companiesNotReached: 0 })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('starts no company after its deadline and counts the ones left', async () => {
      const { supabase } = makeSupabase({
        company_settings: ['company-1', 'company-2'].map((company_id) => ({ company_id, ...raw })),
      })
      // The budget runs out while the räkenskapsår are read: no company is started.
      const reads = supabase.from as ReturnType<typeof vi.fn>
      const realFrom = reads.getMockImplementation() as (table: string) => unknown
      let deadline = Date.now() + 60_000
      reads.mockImplementation((table: string) => {
        if (table === 'fiscal_periods') deadline = Date.now() - 1
        return realFrom(table)
      })

      const result = await alignYearlyVatDeadlinesWithBooks(supabase, {
        get deadline() {
          return deadline
        },
      })

      expect(result).toEqual({ companiesChecked: 0, companiesMoved: 0, companiesNotReached: 2 })
      expect(booksRead).not.toHaveBeenCalled()
    })
  })
})

describe('across the new year: last year\'s periods that fall due this year (crm#2128)', () => {
  // A December or Q4 period falls due in the next calendar year, and the
  // configs are keyed by the year of the period. Regenerated in January, the
  // set must still hold them, or replace_system_tax_deadlines deletes the
  // pending rows while they are still ahead.
  const QUARTERLY: CompanySettingsForDeadlines = { ...SETTINGS, moms_period: 'quarterly' }
  const DECEMBER = new Date(2026, 11, 20, 12)
  const JANUARY = new Date(2027, 0, 5, 12)
  const STILL_AHEAD = [
    'arbetsgivardeklaration:2026-12:2027-01-18',
    'moms_monthly:2026-11:2027-01-18',
    'moms_monthly:2026-12:2027-02-12',
  ]

  afterEach(() => {
    vi.useRealTimers()
  })

  /** The expected rows made on `day` that fall due in January or February 2027. */
  function dueEarly2027(settings: CompanySettingsForDeadlines, day: Date): string[] {
    return Array.from(getExpectedUpcomingDeadlineKeys(settings, [], day))
      .filter((key) => {
        const due = key.slice(key.lastIndexOf(':') + 1)
        return due >= '2027-01-05' && due <= '2027-02-28'
      })
      .sort()
  }

  it('the rows ahead in December are still expected in January', () => {
    for (const settings of [SETTINGS, QUARTERLY]) {
      expect(dueEarly2027(settings, JANUARY)).toEqual(dueEarly2027(settings, DECEMBER))
    }
    expect(dueEarly2027(SETTINGS, JANUARY)).toEqual(expect.arrayContaining(STILL_AHEAD))
    expect(dueEarly2027(QUARTERLY, JANUARY)).toContain('moms_quarterly:2026-Q4:2027-02-12')
  })

  it('a regeneration in January keeps them in the set it replaces with', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(JANUARY)
    const { supabase, getInsertPayload } = makeRecordingSupabase()

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS)

    const keys = getInsertPayload()!.map((row) => `${row.tax_deadline_type}:${row.tax_period}:${row.due_date}`)
    expect(keys).toEqual(expect.arrayContaining(STILL_AHEAD))
  })

  it('the new-year pass on 2 January keeps them for every company', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2027, 0, 2, 0, 30))
    const { fiscal_years: _fy, tax_assessment_notices: _tan, ...raw } = SETTINGS
    const { supabase, inserts } = makeSupabase({ company_settings: [{ company_id: 'company-1', ...raw }] })

    await generateNewYearDeadlines(supabase)

    expect(inserts).toHaveLength(1)
    const keys = inserts[0].map((row) => `${row.tax_deadline_type}:${row.tax_period}:${row.due_date}`)
    expect(keys).toEqual(expect.arrayContaining(STILL_AHEAD))
  })

  it('the nightly repair leaves a company holding them alone in January', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(JANUARY)
    const { fiscal_years: _fy, tax_assessment_notices: _tan, ...raw } = SETTINGS
    const settingsRows = [{ company_id: 'company-1', ...raw, fiscal_years: [], tax_assessment_notices: [] }]
    const held = storedRows('company-1', SETTINGS)
    expect(held.map((row) => `${row.tax_deadline_type}:${row.tax_period}:${row.due_date}`))
      .toEqual(expect.arrayContaining(STILL_AHEAD))

    expect(findSettingsMissingUpcomingDeadlines(settingsRows, held, [], JANUARY)).toEqual([])
    expect(findSettingsWithStaleUpcomingDeadlines(settingsRows, held, [], JANUARY)).toEqual([])
  })
})
