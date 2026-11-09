import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listVatFilings,
  markVatPeriodFiled,
  previewMarkVatPeriodFiled,
  previewUnmarkVatPeriodFiled,
  recordVatFilingConfirmed,
  unmarkVatPeriodFiled,
  vatPeriodDeadline,
  vatPeriodTaxLabel,
} from '../filing-record-store'

/**
 * Sequential query results plus the payloads handed to insert()/update() and
 * the filters each query carried: the payload is where the persisted state
 * is observable, the filters are where the atomic guards are.
 */
function createStoreSupabase(
  results: { data?: unknown; error?: unknown }[],
  fiscalYears: { period_start: string; period_end: string }[] = [],
) {
  const captured: {
    table: string
    insert?: Record<string, unknown>
    update?: Record<string, unknown>
    filters: unknown[][]
    orders?: unknown[][]
  }[] = []
  let idx = 0
  const from = (table: string) => {
    // The recorded räkenskapsår are answered by table and left out of the
    // record: every entry point reads them, and a test states the company's
    // years rather than a position in the queue.
    const isYears = table === 'fiscal_periods'
    const result = isYears ? { data: fiscalYears, error: null } : (results[idx++] ?? { data: null, error: null })
    const entry: (typeof captured)[number] = { table, filters: [] }
    if (!isYears) captured.push(entry)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'limit', 'maybeSingle', 'single']) {
      b[m] = () => b
    }
    b.order = (...args: unknown[]) => {
      ;(entry.orders ??= []).push(args)
      return b
    }
    for (const m of ['eq', 'in', 'is', 'or']) {
      b[m] = (...args: unknown[]) => {
        entry.filters.push([m, ...args])
        return b
      }
    }
    b.insert = (payload: Record<string, unknown>) => {
      entry.insert = payload
      return b
    }
    b.update = (payload: Record<string, unknown>) => {
      entry.update = payload
      return b
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null })
    return b
  }
  return { supabase: { from } as unknown as SupabaseClient, captured }
}

const COMPANY = 'company-1'
const TODAY = '2026-09-17'

/**
 * Every entry point reads the company's VAT settings first: the fiscal-year
 * end month places a yearly period. An aktiebolag on the calendar year, and
 * one whose räkenskapsår runs July-June.
 */
const CALENDAR_AB = {
  data: {
    entity_type: 'aktiebolag',
    fiscal_year_start_month: 1,
    vat_taxable_base_over_40m: false,
    vat_has_eu_trade: false,
    vat_filing_method: 'electronic',
  },
}
const BROKEN_AB = { data: { ...CALENDAR_AB.data, fiscal_year_start_month: 7 } }

const pendingRow = {
  id: 'd-q2',
  tax_deadline_type: 'moms_quarterly',
  tax_period: '2026-Q2',
  is_completed: false,
  completed_at: null,
  status: 'overdue',
  notes: 'Egen anteckning',
  due_date: '2026-08-17',
}

// Räkenskapsår 2025-07-01 - 2026-06-30, helårsmoms due 2027-01-17 (moved to
// the next banking day, 2027-01-18).
const pendingYearRow = {
  id: 'd-fy',
  tax_deadline_type: 'moms_yearly',
  tax_period: '2025/2026',
  is_completed: false,
  completed_at: null,
  status: 'upcoming',
  notes: null,
  due_date: '2027-01-18',
}

describe('a stale settings month against the recorded räkenskapsår', () => {
  // Settings say January, the books say July-June: 9 helårsmoms filers on prod.
  const RECORDED = [
    { period_start: '2024-07-01', period_end: '2025-06-30' },
    { period_start: '2025-07-01', period_end: '2026-06-30' },
  ]

  it('marks the deadline row the generator built, under the recorded year\'s label', async () => {
    const { supabase, captured } = createStoreSupabase(
      [CALENDAR_AB, { data: pendingYearRow }, { data: { ...pendingYearRow, is_completed: true, completed_at: `${TODAY}T12:00:00.000Z`, status: 'submitted' } }],
      RECORDED,
    )
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'yearly', year: 2026, period: 1, filedOn: TODAY },
      { today: TODAY },
    )
    expect(result).toMatchObject({
      ok: true,
      created: false,
      record: { tax_period: '2025/2026', period_start: '2025-07-01', period_end: '2026-06-30' },
    })
    expect(captured.find((c) => c.table === 'deadlines')?.filters).toContainEqual(['eq', 'tax_period', '2025/2026'])
    expect(captured.some((c) => c.insert)).toBe(false)
  })

  it('ends the period with the recorded year, so a filing is not refused as not ended', async () => {
    const { supabase } = createStoreSupabase([CALENDAR_AB, { data: pendingYearRow }], RECORDED)
    const preview = await previewMarkVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'yearly', year: 2026, period: 1, filedOn: TODAY },
      { today: TODAY },
    )
    expect(preview).toMatchObject({
      ok: true,
      would_mark: { tax_period: '2025/2026', period_end: '2026-06-30' },
    })
  })

  it('reads the period\'s due date off the recorded year', async () => {
    const { supabase } = createStoreSupabase([CALENDAR_AB, { data: null }], RECORDED)
    const deadline = await vatPeriodDeadline(supabase, COMPANY, { periodType: 'yearly', year: 2026, period: 1 })
    expect(deadline).toMatchObject({ tax_period: '2025/2026', period_end: '2026-06-30', due_date: '2027-01-18' })
  })

  it('labels the period for the Skatteverket panel the same way', async () => {
    const { supabase } = createStoreSupabase([CALENDAR_AB], RECORDED)
    await expect(vatPeriodTaxLabel(supabase, COMPANY, { periodType: 'yearly', year: 2026, period: 1 })).resolves.toBe(
      '2025/2026',
    )
  })

  it('places a year not created yet on the chain, not on the settings month', async () => {
    const { supabase } = createStoreSupabase([CALENDAR_AB, { data: null }], RECORDED)
    const deadline = await vatPeriodDeadline(supabase, COMPANY, { periodType: 'yearly', year: 2027, period: 1 })
    expect(deadline).toMatchObject({ tax_period: '2026/2027', period_start: '2026-07-01', period_end: '2027-06-30' })
  })

  it('reads a filed broken label off the recorded year', async () => {
    const { supabase } = createStoreSupabase(
      [
        CALENDAR_AB,
        { data: [{ ...pendingYearRow, is_completed: true, completed_at: '2026-09-01T12:00:00.000Z', status: 'submitted' }] },
      ],
      RECORDED,
    )
    const [record] = await listVatFilings(supabase, COMPANY)
    expect(record).toMatchObject({ tax_period: '2025/2026', period_start: '2025-07-01', period_end: '2026-06-30' })
  })
})

describe('a helårsmoms period is the räkenskapsår itself', () => {
  const filedYear = { ...pendingYearRow, is_completed: true, completed_at: '2026-10-01T12:00:00.000Z', status: 'submitted' }

  it('starts a filed extended first year on its own first day', async () => {
    // What filed-period-changes reads: 18 months, not the last twelve of them.
    const { supabase } = createStoreSupabase(
      [BROKEN_AB, { data: [{ ...filedYear, tax_period: '2025/2026' }] }],
      [{ period_start: '2025-03-01', period_end: '2026-08-31' }],
    )
    const [record] = await listVatFilings(supabase, COMPANY)
    expect(record).toMatchObject({ period_start: '2025-03-01', period_end: '2026-08-31' })
  })

  it('starts a short first year on its own first day, also under a calendar label', async () => {
    const { supabase } = createStoreSupabase(
      [CALENDAR_AB, { data: [{ ...filedYear, tax_period: '2025' }] }],
      [{ period_start: '2025-06-01', period_end: '2025-12-31' }],
    )
    const [record] = await listVatFilings(supabase, COMPANY)
    expect(record).toMatchObject({ period_start: '2025-06-01', period_end: '2025-12-31' })
  })

  it('places a period before it is filed the same way', async () => {
    const { supabase } = createStoreSupabase([CALENDAR_AB, { data: null }], [{ period_start: '2025-03-01', period_end: '2026-08-31' }])
    await expect(vatPeriodDeadline(supabase, COMPANY, { periodType: 'yearly', year: 2026, period: 1 })).resolves.toMatchObject({
      period_start: '2025-03-01',
      period_end: '2026-08-31',
    })
  })

  it('keeps twelve months when no year ends in that month', async () => {
    const { supabase } = createStoreSupabase(
      [CALENDAR_AB, { data: [{ ...filedYear, tax_period: '2024' }] }],
      [{ period_start: '2025-03-01', period_end: '2026-08-31' }],
    )
    const [record] = await listVatFilings(supabase, COMPANY)
    expect(record).toMatchObject({ period_start: '2024-01-01', period_end: '2024-12-31' })
  })

  it('leaves the quarters as they are', async () => {
    const { supabase } = createStoreSupabase(
      [CALENDAR_AB, { data: null }],
      [{ period_start: '2026-05-10', period_end: '2026-12-31' }],
    )
    await expect(vatPeriodDeadline(supabase, COMPANY, { periodType: 'quarterly', year: 2026, period: 2 })).resolves.toMatchObject({
      period_start: '2026-04-01',
      period_end: '2026-06-30',
    })
  })
})

describe('an enskild firma on recorded broken years', () => {
  // The generator labels the form's helårsmoms by the calendar year whatever
  // its stored years say, so the filing record has to find that row.
  const ENSKILD_FIRMA = { data: { ...CALENDAR_AB.data, entity_type: 'enskild_firma' } }
  const RECORDED = [
    { period_start: '2024-09-01', period_end: '2025-08-31' },
    { period_start: '2025-09-01', period_end: '2026-08-31' },
  ]
  const generatorRow = { ...pendingYearRow, id: 'd-ef', tax_period: '2025', due_date: '2026-08-17', status: 'overdue' }
  const filedRow = { ...generatorRow, is_completed: true, completed_at: '2026-03-01T12:00:00.000Z', status: 'submitted' }
  const period = { periodType: 'yearly' as const, year: 2025, period: 1 }

  it('completes the row the generator built instead of adding a second one', async () => {
    const { supabase, captured } = createStoreSupabase(
      [ENSKILD_FIRMA, { data: generatorRow }, { data: filedRow }],
      RECORDED,
    )
    const result = await markVatPeriodFiled(supabase, COMPANY, { ...period, filedOn: '2026-03-01' }, { today: TODAY })
    expect(result).toMatchObject({ ok: true, created: false, record: { tax_period: '2025', period_end: '2025-12-31' } })
    expect(captured.find((c) => c.table === 'deadlines')?.filters).toContainEqual(['eq', 'tax_period', '2025'])
    expect(captured.some((c) => c.insert)).toBe(false)
  })

  it('reads the period as filed once that row is completed', async () => {
    const { supabase } = createStoreSupabase([ENSKILD_FIRMA, { data: filedRow }], RECORDED)
    await expect(vatPeriodDeadline(supabase, COMPANY, period)).resolves.toMatchObject({
      tax_period: '2025',
      due_date: '2026-08-17',
      filed: true,
    })
  })

  it('finds the mark again to undo it', async () => {
    const { supabase, captured } = createStoreSupabase(
      [ENSKILD_FIRMA, { data: filedRow }, { data: { id: 'd-ef', status: 'overdue' } }],
      RECORDED,
    )
    await expect(unmarkVatPeriodFiled(supabase, COMPANY, period, { today: TODAY })).resolves.toEqual({
      ok: true,
      deadline_id: 'd-ef',
    })
    expect(captured.find((c) => c.table === 'deadlines')?.filters).toContainEqual(['eq', 'tax_period', '2025'])
  })

  it('labels the period for the Skatteverket panel the same way', async () => {
    const { supabase } = createStoreSupabase([ENSKILD_FIRMA], RECORDED)
    await expect(vatPeriodTaxLabel(supabase, COMPANY, period)).resolves.toBe('2025')
  })
})

describe('listVatFilings', () => {
  it('maps completed moms deadlines of every cadence to records with their dates', async () => {
    const { supabase, captured } = createStoreSupabase([
      BROKEN_AB,
      {
        data: [
          {
            id: 'd-q2',
            tax_deadline_type: 'moms_quarterly',
            tax_period: '2026-Q2',
            is_completed: true,
            // 22:30 UTC is 00:30 the next day in Stockholm (CEST).
            completed_at: '2026-08-11T22:30:00.000Z',
            status: 'confirmed',
            notes: null,
            due_date: '2026-08-17',
          },
          {
            id: 'd-m03',
            tax_deadline_type: 'moms_monthly',
            tax_period: '2026-03',
            is_completed: true,
            completed_at: '2026-05-10T12:00:00.000Z',
            status: 'submitted',
            notes: 'Skatteverkets referens: KV-9',
            due_date: '2026-05-12',
          },
          {
            id: 'd-fy',
            tax_deadline_type: 'moms_yearly',
            tax_period: '2025/2026',
            is_completed: true,
            completed_at: '2026-08-20T12:00:00.000Z',
            status: 'submitted',
            notes: null,
            due_date: '2027-01-18',
          },
          {
            // Written while the company still had a calendar räkenskapsår.
            id: 'd-fy-old',
            tax_deadline_type: 'moms_yearly',
            tax_period: '2024',
            is_completed: true,
            completed_at: '2025-07-01T12:00:00.000Z',
            status: 'confirmed',
            notes: null,
            due_date: '2025-08-18',
          },
          {
            id: 'd-broken',
            tax_deadline_type: 'moms_quarterly',
            tax_period: '2026-Q1',
            is_completed: true,
            completed_at: null,
            status: 'submitted',
            notes: null,
            due_date: '2026-05-12',
          },
        ],
      },
    ])
    const records = await listVatFilings(supabase, COMPANY)
    expect(records).toEqual([
      {
        deadline_id: 'd-q2',
        period_type: 'quarterly',
        year: 2026,
        period: 2,
        tax_period: '2026-Q2',
        period_start: '2026-04-01',
        period_end: '2026-06-30',
        filed_on: '2026-08-12',
        source: 'skatteverket',
        reference: null,
      },
      {
        deadline_id: 'd-m03',
        period_type: 'monthly',
        year: 2026,
        period: 3,
        tax_period: '2026-03',
        period_start: '2026-03-01',
        period_end: '2026-03-31',
        filed_on: '2026-05-10',
        source: 'manual',
        reference: 'KV-9',
      },
      {
        deadline_id: 'd-fy',
        period_type: 'yearly',
        year: 2026,
        period: 1,
        tax_period: '2025/2026',
        period_start: '2025-07-01',
        period_end: '2026-06-30',
        filed_on: '2026-08-20',
        source: 'manual',
        reference: null,
      },
      {
        deadline_id: 'd-fy-old',
        period_type: 'yearly',
        year: 2024,
        period: 1,
        tax_period: '2024',
        // A `YYYY` label is a calendar räkenskapsår whatever the company says today.
        period_start: '2024-01-01',
        period_end: '2024-12-31',
        filed_on: '2025-07-01',
        source: 'skatteverket',
        reference: null,
      },
    ])
    expect(captured[0].table).toBe('company_settings')
    expect(captured[1].filters).toContainEqual([
      'in',
      'tax_deadline_type',
      ['moms_monthly', 'moms_quarterly', 'moms_yearly'],
    ])
    expect(captured[1].filters).toContainEqual(['eq', 'company_id', COMPANY])
  })

  it('throws on a query error', async () => {
    const { supabase } = createStoreSupabase([CALENDAR_AB, { error: { message: 'boom' } }])
    await expect(listVatFilings(supabase, COMPANY)).rejects.toEqual({ message: 'boom' })
  })
})

describe('markVatPeriodFiled', () => {
  it('refuses bad dates before touching the deadlines', async () => {
    const { supabase, captured } = createStoreSupabase([CALENDAR_AB, CALENDAR_AB, CALENDAR_AB])
    const base = { periodType: 'quarterly' as const, year: 2026, period: 2 }
    await expect(
      markVatPeriodFiled(supabase, COMPANY, { ...base, period: 3, filedOn: TODAY }, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_PERIOD_NOT_ENDED' })
    await expect(
      markVatPeriodFiled(supabase, COMPANY, { ...base, filedOn: '2026-06-30' }, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_DATE_BEFORE_PERIOD_END' })
    await expect(
      markVatPeriodFiled(supabase, COMPANY, { ...base, filedOn: '2026-09-18' }, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_DATE_IN_FUTURE' })
    expect(captured.map((c) => c.table)).toEqual(['company_settings', 'company_settings', 'company_settings'])
  })

  it('completes the existing deadline row with the date and reference', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: pendingRow },
      {
        data: {
          ...pendingRow,
          is_completed: true,
          completed_at: '2026-08-10T12:00:00.000Z',
          status: 'submitted',
          notes: 'Egen anteckning\nSkatteverkets referens: KV-1',
        },
      },
    ])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10', reference: 'KV-1' },
      { today: TODAY },
    )
    expect(result).toMatchObject({
      ok: true,
      created: false,
      changed: true,
      record: { deadline_id: 'd-q2', filed_on: '2026-08-10', source: 'manual', reference: 'KV-1' },
    })
    expect(captured[1].filters).toContainEqual(['eq', 'tax_period', '2026-Q2'])
    expect(captured[2].table).toBe('deadlines')
    expect(captured[2].update).toMatchObject({
      is_completed: true,
      completed_at: '2026-08-10T12:00:00.000Z',
      status: 'submitted',
      notes: 'Egen anteckning\nSkatteverkets referens: KV-1',
    })
    // The guard rides on the UPDATE itself, not only on the read before it.
    expect(captured[2].filters).toContainEqual([
      'or',
      'is_completed.eq.false,status.is.null,status.neq.confirmed',
    ])
  })

  it('returns a confirmation that another writer inserted between its read and its insert', async () => {
    const confirmed = { ...pendingRow, is_completed: true, completed_at: '2026-09-08T09:00:00.000Z', status: 'confirmed' }
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: null }, // read: no row for the period
      {
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "idx_deadlines_vat_filing_period_unique"',
        },
      },
      CALENDAR_AB,
      { data: confirmed }, // read again: the kvittens read won
    ])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10' },
      { today: TODAY },
    )
    expect(result).toMatchObject({ ok: true, created: false, changed: false, record: { source: 'skatteverket' } })
    expect(captured.filter((c) => c.update)).toHaveLength(0)
  })

  it('yields to a Skatteverket confirmation that lands between the read and the write', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: pendingRow }, // read: still pending
      { data: null }, // guarded update matched zero rows: the cron got there first
      {
        data: {
          ...pendingRow,
          is_completed: true,
          completed_at: '2026-08-11T09:00:00.000Z',
          status: 'confirmed',
        },
      }, // re-read: confirmed
    ])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10', reference: 'KV-1' },
      { today: TODAY },
    )
    expect(result).toMatchObject({
      ok: true,
      created: false,
      changed: false,
      record: { source: 'skatteverket', filed_on: '2026-08-11', reference: null },
    })
    expect(captured).toHaveLength(4)
  })

  it('answers a conflict when the row changed under it for any other reason', async () => {
    const { supabase } = createStoreSupabase([CALENDAR_AB, { data: pendingRow }, { data: null }, { data: null }])
    await expect(
      markVatPeriodFiled(
        supabase,
        COMPANY,
        { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10' },
        { today: TODAY },
      ),
    ).resolves.toEqual({ ok: false, code: 'CONFLICT' })
  })

  it('leaves a Skatteverket-confirmed period untouched', async () => {
    const confirmed = {
      ...pendingRow,
      is_completed: true,
      completed_at: '2026-08-11T09:00:00.000Z',
      status: 'confirmed',
    }
    const { supabase, captured } = createStoreSupabase([CALENDAR_AB, { data: confirmed }])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10' },
      { today: TODAY },
    )
    expect(result).toMatchObject({
      ok: true,
      created: false,
      changed: false,
      record: { source: 'skatteverket', filed_on: '2026-08-11' },
    })
    expect(captured).toHaveLength(2)
    expect(captured.some((c) => c.update || c.insert)).toBe(false)
  })

  it('creates the deadline row the generator would have, already completed', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: null },
      {
        data: {
          id: 'd-new',
          tax_deadline_type: 'moms_quarterly',
          tax_period: '2026-Q2',
          is_completed: true,
          completed_at: '2026-08-10T12:00:00.000Z',
          status: 'submitted',
          notes: null,
          due_date: '2026-08-17',
        },
      },
    ])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10', userId: 'user-1' },
      { today: TODAY },
    )
    expect(result).toMatchObject({ ok: true, created: true, changed: true })
    expect(captured[2].table).toBe('deadlines')
    expect(captured[2].insert).toMatchObject({
      company_id: COMPANY,
      user_id: 'user-1',
      title: 'Momsdeklaration Q2 2026',
      due_date: '2026-08-17',
      deadline_type: 'tax',
      is_completed: true,
      completed_at: '2026-08-10T12:00:00.000Z',
      source: 'system',
      status: 'submitted',
      notes: null,
      tax_deadline_type: 'moms_quarterly',
      tax_period: '2026-Q2',
      linked_report_type: 'vat',
      linked_report_period: { year: 2026, quarter: 2 },
      is_auto_generated: true,
    })
  })
})

describe('markVatPeriodFiled for helårsmoms (#2786)', () => {
  const yearly = { periodType: 'yearly' as const, year: 2026, period: 1 }

  it('finds a broken räkenskapsår by its deadline label and completes it', async () => {
    const { supabase, captured } = createStoreSupabase([
      BROKEN_AB,
      { data: pendingYearRow },
      {
        data: {
          ...pendingYearRow,
          is_completed: true,
          completed_at: '2026-08-20T12:00:00.000Z',
          status: 'submitted',
          notes: 'Skatteverkets referens: KV-7',
        },
      },
    ])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { ...yearly, filedOn: '2026-08-20', reference: 'KV-7' },
      { today: TODAY },
    )
    expect(captured[1].filters).toContainEqual(['eq', 'tax_period', '2025/2026'])
    expect(result).toEqual({
      ok: true,
      created: false,
      changed: true,
      record: {
        deadline_id: 'd-fy',
        period_type: 'yearly',
        year: 2026,
        period: 1,
        tax_period: '2025/2026',
        period_start: '2025-07-01',
        period_end: '2026-06-30',
        filed_on: '2026-08-20',
        source: 'manual',
        reference: 'KV-7',
      },
    })
  })

  it('judges the date rules by the räkenskapsår end, not December', async () => {
    // Under a calendar räkenskapsår the year ending 2026 is still running.
    const calendar = createStoreSupabase([CALENDAR_AB])
    await expect(
      markVatPeriodFiled(calendar.supabase, COMPANY, { ...yearly, filedOn: '2026-08-20' }, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_PERIOD_NOT_ENDED' })
    const broken = createStoreSupabase([BROKEN_AB])
    await expect(
      markVatPeriodFiled(broken.supabase, COMPANY, { ...yearly, filedOn: '2026-06-30' }, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_DATE_BEFORE_PERIOD_END' })
  })

  it('creates the moms_yearly row the generator would have, labelled per räkenskapsår', async () => {
    const { supabase, captured } = createStoreSupabase([
      BROKEN_AB,
      { data: null },
      {
        data: {
          ...pendingYearRow,
          id: 'd-new',
          is_completed: true,
          completed_at: '2026-08-20T12:00:00.000Z',
          status: 'submitted',
        },
      },
    ])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { ...yearly, filedOn: '2026-08-20', userId: 'user-1' },
      { today: TODAY },
    )
    expect(result).toMatchObject({ ok: true, created: true, changed: true })
    expect(captured[2].insert).toMatchObject({
      title: 'Momsdeklaration 2025/2026',
      // AB, räkenskapsår ending June, no EU trade, e-filed: 17 January the
      // year after, a Sunday in 2027, so the next banking day.
      due_date: '2027-01-18',
      tax_deadline_type: 'moms_yearly',
      tax_period: '2025/2026',
      linked_report_period: { startYear: 2025, endYear: 2026 },
      is_completed: true,
      status: 'submitted',
    })
  })

  it('never relabels a Skatteverket-confirmed räkenskapsår', async () => {
    const confirmed = {
      ...pendingYearRow,
      is_completed: true,
      completed_at: '2026-08-15T09:00:00.000Z',
      status: 'confirmed',
    }
    const { supabase, captured } = createStoreSupabase([BROKEN_AB, { data: confirmed }])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { ...yearly, filedOn: '2026-08-20' },
      { today: TODAY },
    )
    expect(result).toMatchObject({ ok: true, changed: false, record: { source: 'skatteverket' } })
    expect(captured.some((c) => c.update || c.insert)).toBe(false)
  })
})

describe('previewMarkVatPeriodFiled', () => {
  it('gives the refusal the write would give, without reading the deadlines', async () => {
    const { supabase, captured } = createStoreSupabase([CALENDAR_AB])
    await expect(
      previewMarkVatPeriodFiled(
        supabase,
        COMPANY,
        { periodType: 'yearly', year: 2026, period: 1, filedOn: '2026-08-20' },
        { today: TODAY },
      ),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_PERIOD_NOT_ENDED' })
    expect(captured).toHaveLength(1)
  })

  it('describes the record it would leave and writes nothing', async () => {
    const { supabase, captured } = createStoreSupabase([
      BROKEN_AB,
      { data: { ...pendingYearRow, notes: 'Skatteverkets referens: OLD' } },
    ])
    const preview = await previewMarkVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'yearly', year: 2026, period: 1, filedOn: '2026-08-20' },
      { today: TODAY },
    )
    expect(preview).toEqual({
      ok: true,
      would_mark: {
        period_type: 'yearly',
        year: 2026,
        period: 1,
        tax_period: '2025/2026',
        period_start: '2025-07-01',
        period_end: '2026-06-30',
        filed_on: '2026-08-20',
        // Omitted reference: the stored one stays.
        reference: 'OLD',
      },
      effect: 'update',
      current: null,
    })
    expect(captured.some((c) => c.update || c.insert)).toBe(false)
  })

  it('says a confirmed period stays as it is, and a missing row is created', async () => {
    const confirmed = createStoreSupabase([
      CALENDAR_AB,
      { data: { ...pendingRow, is_completed: true, completed_at: '2026-08-11T09:00:00.000Z', status: 'confirmed' } },
    ])
    await expect(
      previewMarkVatPeriodFiled(
        confirmed.supabase,
        COMPANY,
        { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10', reference: null },
        { today: TODAY },
      ),
    ).resolves.toMatchObject({ ok: true, effect: 'unchanged', current: { source: 'skatteverket' } })
    const missing = createStoreSupabase([CALENDAR_AB, { data: null }])
    await expect(
      previewMarkVatPeriodFiled(
        missing.supabase,
        COMPANY,
        { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10', reference: ' KV-2 ' },
        { today: TODAY },
      ),
    ).resolves.toMatchObject({ ok: true, effect: 'create', current: null, would_mark: { reference: 'KV-2' } })
  })
})

describe('unmarkVatPeriodFiled', () => {
  const input = { periodType: 'quarterly' as const, year: 2026, period: 2 }

  it('answers not found when the period has no completed row', async () => {
    const none = createStoreSupabase([CALENDAR_AB, { data: null }])
    await expect(unmarkVatPeriodFiled(none.supabase, COMPANY, input, { today: TODAY })).resolves.toEqual({
      ok: false,
      code: 'VAT_FILING_NOT_FOUND',
    })
    const pending = createStoreSupabase([CALENDAR_AB, { data: pendingRow }])
    await expect(
      unmarkVatPeriodFiled(pending.supabase, COMPANY, input, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_NOT_FOUND' })
  })

  it('refuses to erase a Skatteverket kvittens', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: { ...pendingRow, is_completed: true, completed_at: '2026-08-11T09:00:00.000Z', status: 'confirmed' } },
    ])
    await expect(unmarkVatPeriodFiled(supabase, COMPANY, input, { today: TODAY })).resolves.toEqual({
      ok: false,
      code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET',
    })
    expect(captured).toHaveLength(2)
    expect(captured.some((c) => c.update)).toBe(false)
  })

  it('a deadline due today goes back to upcoming, not overdue', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: { ...pendingRow, is_completed: true, completed_at: '2026-08-10T12:00:00.000Z', status: 'submitted', notes: null } },
      { data: { id: 'd-q2' } },
    ])
    await unmarkVatPeriodFiled(supabase, COMPANY, input, { today: pendingRow.due_date })
    expect(captured[2].update).toMatchObject({ status: 'upcoming' })
  })

  it('puts a manual mark back to pending and drops the reference line', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      {
        data: {
          ...pendingRow,
          is_completed: true,
          completed_at: '2026-08-10T12:00:00.000Z',
          status: 'submitted',
          notes: 'Egen anteckning\nSkatteverkets referens: KV-1',
        },
      },
      { data: { id: 'd-q2' } },
    ])
    await expect(unmarkVatPeriodFiled(supabase, COMPANY, input, { today: TODAY })).resolves.toEqual({
      ok: true,
      deadline_id: 'd-q2',
    })
    expect(captured[2].update).toMatchObject({
      is_completed: false,
      completed_at: null,
      // due 2026-08-17 is behind today, so straight to overdue.
      status: 'overdue',
      notes: 'Egen anteckning',
    })
    // Only a row that is still a completed, unconfirmed filing is unmarked.
    expect(captured[2].filters).toContainEqual(['eq', 'is_completed', true])
    expect(captured[2].filters).toContainEqual(['or', 'status.is.null,status.neq.confirmed'])
  })

  it('undoes a manual helårsmoms mark, found by its räkenskapsår label', async () => {
    const { supabase, captured } = createStoreSupabase([
      BROKEN_AB,
      { data: { ...pendingYearRow, is_completed: true, completed_at: '2026-08-20T12:00:00.000Z', status: 'submitted' } },
      { data: { id: 'd-fy' } },
    ])
    await expect(
      unmarkVatPeriodFiled(supabase, COMPANY, { periodType: 'yearly', year: 2026, period: 1 }, { today: TODAY }),
    ).resolves.toEqual({ ok: true, deadline_id: 'd-fy' })
    expect(captured[1].filters).toContainEqual(['eq', 'tax_period', '2025/2026'])
    // Due 2027-01-18, still ahead: back to upcoming.
    expect(captured[2].update).toMatchObject({ is_completed: false, status: 'upcoming' })
  })

  const manualRow = {
    ...pendingRow,
    is_completed: true,
    completed_at: '2026-08-10T12:00:00.000Z',
    status: 'submitted',
  }

  it('never reports success when the guarded update matched nothing', async () => {
    // Confirmed in between: the refusal names the real reason.
    const confirmedNow = createStoreSupabase([
      CALENDAR_AB,
      { data: manualRow },
      { data: null },
      { data: { ...manualRow, completed_at: '2026-08-11T09:00:00.000Z', status: 'confirmed' } },
    ])
    await expect(
      unmarkVatPeriodFiled(confirmedNow.supabase, COMPANY, input, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET' })

    // Already un-ticked elsewhere (the deadlines page, another tab).
    const alreadyPending = createStoreSupabase([
      CALENDAR_AB,
      { data: manualRow },
      { data: null },
      { data: pendingRow },
    ])
    await expect(
      unmarkVatPeriodFiled(alreadyPending.supabase, COMPANY, input, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_NOT_FOUND' })
  })
})

describe('previewUnmarkVatPeriodFiled', () => {
  const input = { periodType: 'quarterly' as const, year: 2026, period: 2 }

  it('refuses what the write refuses', async () => {
    const confirmed = createStoreSupabase([
      CALENDAR_AB,
      { data: { ...pendingRow, is_completed: true, completed_at: '2026-08-11T09:00:00.000Z', status: 'confirmed' } },
    ])
    await expect(previewUnmarkVatPeriodFiled(confirmed.supabase, COMPANY, input)).resolves.toEqual({
      ok: false,
      code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET',
    })
    const none = createStoreSupabase([CALENDAR_AB, { data: null }])
    await expect(previewUnmarkVatPeriodFiled(none.supabase, COMPANY, input)).resolves.toEqual({
      ok: false,
      code: 'VAT_FILING_NOT_FOUND',
    })
  })

  it('names the record it would put back to pending and writes nothing', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: { ...pendingRow, is_completed: true, completed_at: '2026-08-10T12:00:00.000Z', status: 'submitted' } },
    ])
    await expect(previewUnmarkVatPeriodFiled(supabase, COMPANY, input)).resolves.toMatchObject({
      ok: true,
      would_unmark: { period_type: 'quarterly', tax_period: '2026-Q2', period_end: '2026-06-30' },
      current: { deadline_id: 'd-q2', source: 'manual' },
    })
    expect(captured.some((c) => c.update)).toBe(false)
  })
})

describe('recordVatFilingConfirmed', () => {
  const NOW = new Date('2026-09-08T10:30:42.000Z')

  it('creates a confirmed row when the period predates the deadline calendar', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: null },
      {
        data: {
          id: 'd-new',
          tax_deadline_type: 'moms_quarterly',
          tax_period: '2026-Q2',
          is_completed: true,
          completed_at: NOW.toISOString(),
          status: 'confirmed',
          notes: null,
          due_date: '2026-08-17',
        },
      },
    ])
    const result = await recordVatFilingConfirmed(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2 },
      { now: NOW },
    )
    expect(result).toMatchObject({
      created: true,
      changed: true,
      record: { source: 'skatteverket', tax_period: '2026-Q2', filed_on: '2026-09-08' },
    })
    expect(captured[2].insert).toMatchObject({
      company_id: COMPANY,
      title: 'Momsdeklaration Q2 2026',
      due_date: '2026-08-17',
      is_completed: true,
      completed_at: NOW.toISOString(),
      status: 'confirmed',
      tax_deadline_type: 'moms_quarterly',
      tax_period: '2026-Q2',
      linked_report_period: { year: 2026, quarter: 2 },
    })
  })

  it('confirms a pending row in place', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: pendingRow },
      {
        data: {
          ...pendingRow,
          is_completed: true,
          completed_at: NOW.toISOString(),
          status: 'confirmed',
        },
      },
    ])
    const result = await recordVatFilingConfirmed(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2 },
      { now: NOW },
    )
    expect(result).toMatchObject({ created: false, changed: true, record: { source: 'skatteverket' } })
    expect(captured[2].update).toEqual({
      is_completed: true,
      completed_at: NOW.toISOString(),
      status: 'confirmed',
      status_changed_at: NOW.toISOString(),
    })
    expect(captured[2].filters).toContainEqual(['eq', 'id', 'd-q2'])
    expect(captured[2].filters).toContainEqual(['eq', 'company_id', COMPANY])
  })

  it('confirms a helårsmoms period through the same path, by its räkenskapsår label', async () => {
    const { supabase, captured } = createStoreSupabase([
      BROKEN_AB,
      { data: pendingYearRow },
      { data: { ...pendingYearRow, is_completed: true, completed_at: NOW.toISOString(), status: 'confirmed' } },
    ])
    const result = await recordVatFilingConfirmed(
      supabase,
      COMPANY,
      { periodType: 'yearly', year: 2026, period: 1 },
      { now: NOW },
    )
    expect(captured[1].filters).toContainEqual(['eq', 'tax_period', '2025/2026'])
    expect(result.record).toMatchObject({
      period_type: 'yearly',
      year: 2026,
      tax_period: '2025/2026',
      period_end: '2026-06-30',
      source: 'skatteverket',
    })
  })

  it('upgrades a manual mark and keeps its reference', async () => {
    const manual = {
      ...pendingRow,
      is_completed: true,
      completed_at: '2026-09-03T12:00:00.000Z',
      status: 'submitted',
    }
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: manual },
      { data: { ...manual, completed_at: NOW.toISOString(), status: 'confirmed' } },
    ])
    const result = await recordVatFilingConfirmed(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2 },
      { now: NOW },
    )
    expect(result).toMatchObject({ created: false, changed: true })
    expect(captured[2].update).not.toHaveProperty('notes')
  })

  it('upgrades a manual mark without moving its filed-on date', async () => {
    const manual = {
      ...pendingRow,
      is_completed: true,
      completed_at: '2026-09-03T12:00:00.000Z',
      status: 'submitted',
    }
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: manual },
      { data: { ...manual, status: 'confirmed' } },
    ])
    const result = await recordVatFilingConfirmed(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2 },
      { now: NOW },
    )
    expect(captured[2].update).toEqual({
      is_completed: true,
      completed_at: '2026-09-03T12:00:00.000Z',
      status: 'confirmed',
      status_changed_at: NOW.toISOString(),
    })
    expect(result.record).toMatchObject({ source: 'skatteverket', filed_on: '2026-09-03' })
  })

  it('leaves an already confirmed period untouched', async () => {
    const confirmed = {
      ...pendingRow,
      is_completed: true,
      completed_at: '2026-08-11T09:00:00.000Z',
      status: 'confirmed',
    }
    const { supabase, captured } = createStoreSupabase([CALENDAR_AB, { data: confirmed }])
    const result = await recordVatFilingConfirmed(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2 },
      { now: NOW },
    )
    expect(result).toMatchObject({ created: false, changed: false })
    expect(captured).toHaveLength(2)
  })

  const PERIOD_CONFLICT = {
    error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_deadlines_vat_filing_period_unique"' },
  }
  const confirmedQ2 = {
    ...pendingRow,
    is_completed: true,
    completed_at: '2026-09-08T09:00:00.000Z',
    status: 'confirmed',
  }
  const submittedQ2 = {
    ...pendingRow,
    is_completed: true,
    completed_at: '2026-08-10T12:00:00.000Z',
    status: 'submitted',
  }

  it('returns the record unchanged when another kvittens read inserted it first', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: null }, // read: no row yet
      PERIOD_CONFLICT, // insert: the other read won
      CALENDAR_AB,
      { data: confirmedQ2 }, // read again: its confirmation
    ])
    const result = await recordVatFilingConfirmed(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2 },
      { now: NOW },
    )
    expect(result).toMatchObject({ created: false, changed: false, record: { source: 'skatteverket' } })
    expect(captured.filter((c) => c.insert)).toHaveLength(1)
    expect(captured.filter((c) => c.update)).toHaveLength(0)
  })

  it('upgrades a manual mark that was inserted between its read and its insert', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: null },
      PERIOD_CONFLICT,
      CALENDAR_AB,
      { data: submittedQ2 }, // read again: the manual mark won the insert
      { data: { ...submittedQ2, status: 'confirmed' } },
    ])
    const result = await recordVatFilingConfirmed(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2 },
      { now: NOW },
    )
    expect(result).toMatchObject({ created: false, changed: true, record: { source: 'skatteverket' } })
    // The user's filed-on date stays: the kvittens confirms that filing.
    expect(captured[5].update).toMatchObject({
      is_completed: true,
      completed_at: '2026-08-10T12:00:00.000Z',
      status: 'confirmed',
    })
  })

  it('rethrows any other insert failure', async () => {
    const { supabase } = createStoreSupabase([
      CALENDAR_AB,
      { data: null },
      { error: { code: '23505', message: 'duplicate key value violates unique constraint "some_other_index"' } },
    ])
    await expect(
      recordVatFilingConfirmed(supabase, COMPANY, { periodType: 'quarterly', year: 2026, period: 2 }, { now: NOW }),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('reads the completed row first, so a stale pending duplicate never shadows the record', async () => {
    const { supabase, captured } = createStoreSupabase([CALENDAR_AB, { data: confirmedQ2 }])
    await recordVatFilingConfirmed(supabase, COMPANY, { periodType: 'quarterly', year: 2026, period: 2 }, { now: NOW })
    expect(captured[1].orders).toEqual([
      ['is_completed', { ascending: false }],
      ['created_at', { ascending: true }],
    ])
  })

  it('throws on a read error', async () => {
    const { supabase } = createStoreSupabase([{ error: { message: 'boom' } }])
    await expect(
      recordVatFilingConfirmed(supabase, COMPANY, { periodType: 'monthly', year: 2026, period: 7 }),
    ).rejects.toMatchObject({ message: 'boom' })
  })
})

describe('vatPeriodDeadline', () => {
  it('answers the deadline row\'s due date and whether the period is filed', async () => {
    const { supabase, captured } = createStoreSupabase([
      CALENDAR_AB,
      { data: { ...pendingRow, due_date: '2026-08-17', is_completed: true, completed_at: '2026-08-10T12:00:00.000Z', status: 'submitted' } },
    ])
    const result = await vatPeriodDeadline(supabase, COMPANY, { periodType: 'quarterly', year: 2026, period: 2 })
    expect(result).toMatchObject({ tax_period: '2026-Q2', period_end: '2026-06-30', due_date: '2026-08-17', filed: true })
    expect(captured[1].filters).toContainEqual(['eq', 'tax_period', '2026-Q2'])
  })

  it('places the due date the way the generator would when the company has no row, on a banking day', async () => {
    const { supabase } = createStoreSupabase([CALENDAR_AB, { data: null }])
    // Q3 2026 is due 12 November 2026, a Thursday; Q4 2026 on 12 February 2027, a Friday.
    expect(await vatPeriodDeadline(supabase, COMPANY, { periodType: 'quarterly', year: 2026, period: 3 })).toMatchObject({
      due_date: '2026-11-12',
      filed: false,
    })
    const monthly = createStoreSupabase([CALENDAR_AB, { data: null }])
    // July 2026 (small company) is due 12 September 2026, a Saturday: the next banking day.
    expect(await vatPeriodDeadline(monthly.supabase, COMPANY, { periodType: 'monthly', year: 2026, period: 7 })).toMatchObject({
      due_date: '2026-09-14',
    })
  })
})
