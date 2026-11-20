/**
 * What a declaration asks to have on the skattekonto (../skattekonto-sources.ts):
 * the momsdeklaration's ruta 49 as filed and the AGI's skatt + avgifter, with
 * the day the money must be there, everything declared due on one day, and
 * the source fields every door shares.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTableMockSupabase } from '@/tests/helpers'

const vat = vi.hoisted(() => ({ computeVatDeclaration: vi.fn(), vatPeriodDeadline: vi.fn() }))
vi.mock('@/lib/reports/vat-declaration', () => ({ computeVatDeclaration: vat.computeVatDeclaration }))
vi.mock('@/lib/vat/filing-record-store', () => ({ vatPeriodDeadline: vat.vatPeriodDeadline }))

import {
  refineSkattekontoSource,
  resolveSkattekontoDueDate,
  resolveSkattekontoSource,
  SKATTEKONTO_SOURCE_FIELDS,
  toSkattekontoSource,
} from '../skattekonto-sources'

const COMPANY = 'company-1'
const TODAY = '2026-10-16'

function declaration(rutor: Record<string, number>, end = '2026-09-30') {
  return { declaration: { rutor, period: { start: '2026-07-01', end } } }
}

let db: ReturnType<typeof createTableMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  db = createTableMockSupabase({
    agi_declarations: { data: { status: 'submitted', total_tax: 18000, total_avgifter: 12568, tax_paid_at: null } },
    company_settings: { data: { vat_registered: true, vat_taxable_base_over_40m: false } },
    deadlines: { data: [] },
  })
  vat.vatPeriodDeadline.mockResolvedValue({
    period_type: 'quarterly',
    year: 2026,
    period: 3,
    tax_period: '2026-Q3',
    period_start: '2026-07-01',
    period_end: '2026-09-30',
    due_date: '2026-11-12',
    filed: true,
  })
})

const VAT_Q3 = { kind: 'vat_declaration', periodType: 'quarterly', year: 2026, period: 3 } as const

describe('resolveSkattekontoSource: momsdeklaration', () => {
  it('asks for ruta 49 as filed (whole kronor per ruta), by the period deadline', async () => {
    // 25 000,90 out, 6 250,40 in: filed as 25 000 - 6 250 = 18 750.
    vat.computeVatDeclaration.mockResolvedValue(declaration({ ruta10: 25000.9, ruta48: 6250.4, ruta49: 18750.5 }))

    const result = await resolveSkattekontoSource(db.supabase as never, COMPANY, VAT_Q3, TODAY)

    expect(result).toEqual({
      ok: true,
      due: {
        kind: 'vat_declaration',
        tax_period: '2026-Q3',
        declared: 18750,
        due_date: '2026-11-12',
        filed: true,
        paid_at: null,
        payable: 18750,
        nothing_due: null,
        paid_from: '2026-09-30',
      },
    })
    expect(vat.computeVatDeclaration).toHaveBeenCalledWith(db.supabase, COMPANY, 'quarterly', 2026, 3, {})
    expect(vat.vatPeriodDeadline).toHaveBeenCalledWith(db.supabase, COMPANY, { periodType: 'quarterly', year: 2026, period: 3 })
  })

  it('asks for nothing when the declaration is a refund or zero, or the period has not ended', async () => {
    vat.computeVatDeclaration.mockResolvedValue(declaration({ ruta10: 1000, ruta48: 4000 }))
    let result = await resolveSkattekontoSource(db.supabase as never, COMPANY, VAT_Q3, TODAY)
    expect(result).toMatchObject({ ok: true, due: { declared: -3000, payable: null, nothing_due: 'refund' } })

    vat.computeVatDeclaration.mockResolvedValue(declaration({}))
    result = await resolveSkattekontoSource(db.supabase as never, COMPANY, VAT_Q3, TODAY)
    expect(result).toMatchObject({ ok: true, due: { declared: 0, payable: null, nothing_due: 'zero' } })

    vat.computeVatDeclaration.mockResolvedValue(declaration({ ruta10: 5000 }, '2026-12-31'))
    result = await resolveSkattekontoSource(db.supabase as never, COMPANY, { ...VAT_Q3, period: 4 }, TODAY)
    expect(result).toMatchObject({ ok: true, due: { declared: 5000, payable: null, nothing_due: 'period_not_ended' } })

    // On its last day a period has not ended either.
    vat.computeVatDeclaration.mockResolvedValue(declaration({ ruta10: 5000 }, TODAY))
    result = await resolveSkattekontoSource(db.supabase as never, COMPANY, VAT_Q3, TODAY)
    expect(result).toMatchObject({ ok: true, due: { payable: null, nothing_due: 'period_not_ended' } })
  })

  it('says when the period is not on record as filed, and passes a yearly räkenskapsår through', async () => {
    vat.computeVatDeclaration.mockResolvedValue(declaration({ ruta10: 2500 }, '2026-06-30'))
    vat.vatPeriodDeadline.mockResolvedValue({ tax_period: '2025/2026', due_date: '2026-08-26', filed: false })

    const result = await resolveSkattekontoSource(
      db.supabase as never,
      COMPANY,
      { kind: 'vat_declaration', periodType: 'yearly', year: 2026, period: 1, fiscalPeriodId: 'fp-1' },
      TODAY,
    )

    expect(result).toMatchObject({ ok: true, due: { tax_period: '2025/2026', filed: false, payable: 2500 } })
    expect(vat.computeVatDeclaration).toHaveBeenCalledWith(db.supabase, COMPANY, 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' })
  })

  it('answers VAT_REPORT_GENERATION_FAILED when the declaration cannot be computed', async () => {
    vat.computeVatDeclaration.mockRejectedValue(new Error('no fiscal period'))
    const result = await resolveSkattekontoSource(db.supabase as never, COMPANY, VAT_Q3, TODAY)
    expect(result).toMatchObject({ ok: false, code: 'VAT_REPORT_GENERATION_FAILED' })
  })
})

describe('resolveSkattekontoSource: arbetsgivardeklaration', () => {
  it('asks for avdragen skatt + arbetsgivaravgifter, due the 12th of the next month', async () => {
    const result = await resolveSkattekontoSource(db.supabase as never, COMPANY, { kind: 'agi', year: 2026, month: 10 }, TODAY)

    expect(result).toEqual({
      ok: true,
      due: {
        kind: 'agi',
        tax_period: '2026-10',
        declared: 30568,
        due_date: '2026-11-12',
        filed: true,
        paid_at: null,
        payable: 30568,
        nothing_due: null,
        paid_from: '2026-10-01',
      },
    })
    expect(db.findCalls('agi_declarations', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['period_year', 2026],
      ['period_month', 10],
    ])
  })

  it('is due the 17th in August and January, on the next banking day, and the 12th above SEK 40M', async () => {
    let result = await resolveSkattekontoSource(db.supabase as never, COMPANY, { kind: 'agi', year: 2026, month: 7 }, TODAY)
    expect(result).toMatchObject({ ok: true, due: { due_date: '2026-08-17' } })

    // 17 January 2027 is a Sunday.
    result = await resolveSkattekontoSource(db.supabase as never, COMPANY, { kind: 'agi', year: 2026, month: 12 }, TODAY)
    expect(result).toMatchObject({ ok: true, due: { due_date: '2027-01-18' } })

    // Above the SEK 40M VAT taxable base the AGI is filed on the 26th but paid by the 12th.
    db.setTable('company_settings', { data: { vat_registered: true, vat_taxable_base_over_40m: true } })
    result = await resolveSkattekontoSource(db.supabase as never, COMPANY, { kind: 'agi', year: 2026, month: 7 }, TODAY)
    expect(result).toMatchObject({ ok: true, due: { due_date: '2026-08-12' } })
  })

  it('asks for nothing once the month is marked paid, and says when the AGI is not filed', async () => {
    db.setTable('agi_declarations', {
      data: { status: 'generated', total_tax: 1000, total_avgifter: 314, tax_paid_at: '2026-11-12T00:00:00Z' },
    })
    let result = await resolveSkattekontoSource(db.supabase as never, COMPANY, { kind: 'agi', year: 2026, month: 10 }, TODAY)
    expect(result).toMatchObject({ ok: true, due: { declared: 1314, payable: null, nothing_due: 'already_paid', filed: false } })

    // Filed outside Accounted: the month's deadline is completed.
    db.setTable('agi_declarations', { data: { status: 'exported', total_tax: 1000, total_avgifter: 314, tax_paid_at: null } })
    db.setTable('deadlines', { data: [{ is_completed: true }] })
    result = await resolveSkattekontoSource(db.supabase as never, COMPANY, { kind: 'agi', year: 2026, month: 10 }, TODAY)
    expect(result).toMatchObject({ ok: true, due: { payable: 1314, filed: true } })
  })

  it('answers SKATTEKONTO_PAYMENT_AGI_NOT_FOUND for a month without an AGI', async () => {
    db.setTable('agi_declarations', { data: null })
    const result = await resolveSkattekontoSource(db.supabase as never, COMPANY, { kind: 'agi', year: 2026, month: 10 }, TODAY)
    expect(result).toEqual({ ok: false, code: 'SKATTEKONTO_PAYMENT_AGI_NOT_FOUND', details: { tax_period: '2026-10' } })
  })
})

/** salary_runs: the declaration's run by id, and the live runs paid out in the month asked. */
function salaryRuns(live: Array<Record<string, unknown>>, liveError: unknown = null) {
  return (calls: Array<{ method: string; args: unknown[] }>) => {
    const select = calls.find((c) => c.method === 'select')?.args[0]
    if (select === 'id, corrects_run_id') return { data: { id: 'run-own', corrects_run_id: null } }
    return liveError ? { data: null, error: liveError } : { data: live }
  }
}
const OWN_LIVE = { id: 'run-own', status: 'booked', period_year: 2026, period_month: 10, payment_date: '2026-10-25', corrects_run_id: null }
const OTHER_LIVE = { id: 'run-other', status: 'booked', period_year: 2026, period_month: 9, payment_date: '2026-10-05', corrects_run_id: null }
const UNFILED_AGI = { status: 'generated', total_tax: 18000, total_avgifter: 12568, tax_paid_at: null, salary_run_id: 'run-own' }

describe('resolveSkattekontoSource: an AGI holding one run of its month (crm#1768)', () => {
  const OCTOBER = { kind: 'agi', year: 2026, month: 10 } as const

  it('refuses an unfiled declaration while another live run is paid out in the month, naming it', async () => {
    db.setTable('agi_declarations', { data: UNFILED_AGI })
    db.setTable('salary_runs', salaryRuns([OWN_LIVE, OTHER_LIVE]))

    const result = await resolveSkattekontoSource(db.supabase as never, COMPANY, OCTOBER, TODAY)

    expect(result).toMatchObject({
      ok: false,
      code: 'AGI_PAYMENT_PERIOD_CONFLICT',
      details: { period: '2026-10', tax_period: '2026-10', due_date: '2026-11-12', other_salary_run_id: 'run-other' },
    })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.messageSv).toMatch(/^Lönekörningen för 2026-09 med utbetalning 2026-10-05 hör också till redovisningsperiod 2026-10\./)
    expect(db.findCall('salary_runs', 'gte')).toEqual(['payment_date', '2026-10-01'])
  })

  it('pays a single-run month as before', async () => {
    db.setTable('agi_declarations', { data: UNFILED_AGI })
    db.setTable('salary_runs', salaryRuns([OWN_LIVE]))

    const result = await resolveSkattekontoSource(db.supabase as never, COMPANY, OCTOBER, TODAY)

    expect(result).toMatchObject({ ok: true, due: { declared: 30568, payable: 30568, filed: false } })
  })

  it('pays a filed declaration as before, without reading the runs', async () => {
    db.setTable('agi_declarations', { data: { ...UNFILED_AGI, status: 'submitted' } })
    db.setTable('salary_runs', salaryRuns([OWN_LIVE, OTHER_LIVE]))

    const result = await resolveSkattekontoSource(db.supabase as never, COMPANY, OCTOBER, TODAY)

    expect(result).toMatchObject({ ok: true, due: { declared: 30568, payable: 30568, filed: true } })
    expect(db.findCall('salary_runs', 'select')).toBeUndefined()
  })

  it('answers a month marked paid as already paid, as before', async () => {
    db.setTable('agi_declarations', { data: { ...UNFILED_AGI, tax_paid_at: '2026-11-10T00:00:00Z' } })
    db.setTable('salary_runs', salaryRuns([OWN_LIVE, OTHER_LIVE]))

    const result = await resolveSkattekontoSource(db.supabase as never, COMPANY, OCTOBER, TODAY)

    expect(result).toMatchObject({ ok: true, due: { payable: null, nothing_due: 'already_paid' } })
  })

  it('throws when the runs cannot be read, so nothing is paid', async () => {
    db.setTable('agi_declarations', { data: UNFILED_AGI })
    db.setTable('salary_runs', salaryRuns([], { message: 'boom' }))

    await expect(resolveSkattekontoSource(db.supabase as never, COMPANY, OCTOBER, TODAY)).rejects.toEqual({ message: 'boom' })
  })
})

describe('the source fields', () => {
  const schema = z.object(SKATTEKONTO_SOURCE_FIELDS).superRefine(refineSkattekontoSource)

  it('needs each source\'s period, and no period without a source', () => {
    expect(schema.safeParse({ source: 'vat_declaration', year: 2026 }).success).toBe(false)
    expect(schema.safeParse({ source: 'vat_declaration', period_type: 'quarterly', year: 2026, period: 5 }).success).toBe(false)
    expect(schema.safeParse({ source: 'vat_declaration', period_type: 'quarterly', year: 2026, period: 3, fiscal_period_id: '6f0c4a63-2c4e-4d5e-9a3f-0e2b4c6d8a10' }).success).toBe(false)
    expect(schema.safeParse({ source: 'agi', year: 2026 }).success).toBe(false)
    expect(schema.safeParse({ year: 2026, month: 9 }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ source: 'next_charge' }).success).toBe(true)
  })

  it('needs the day for due_date, a real date, and no declaration period beside it', () => {
    expect(schema.safeParse({ source: 'due_date', due_date: '2026-11-12' }).success).toBe(true)
    expect(schema.safeParse({ source: 'due_date' }).success).toBe(false)
    expect(schema.safeParse({ source: 'due_date', due_date: '2026-02-30' }).success).toBe(false)
    expect(schema.safeParse({ source: 'due_date', due_date: '12/11/2026' }).success).toBe(false)
    expect(schema.safeParse({ source: 'due_date', due_date: '2026-11-12', year: 2026 }).success).toBe(false)
    expect(schema.safeParse({ source: 'agi', year: 2026, month: 10, due_date: '2026-11-12' }).success).toBe(false)
    expect(schema.safeParse({ due_date: '2026-11-12' }).success).toBe(false)
  })

  it('turns the fields into a source, and the next charge into none', () => {
    expect(toSkattekontoSource({ source: 'due_date', due_date: '2026-11-12' })).toEqual({ kind: 'due_date', dueDate: '2026-11-12' })
    expect(toSkattekontoSource({ source: 'vat_declaration', period_type: 'monthly', year: 2026, period: 9 })).toEqual({
      kind: 'vat_declaration',
      periodType: 'monthly',
      year: 2026,
      period: 9,
      fiscalPeriodId: null,
    })
    expect(toSkattekontoSource({ source: 'agi', year: 2026, month: 9 })).toEqual({ kind: 'agi', year: 2026, month: 9 })
    expect(toSkattekontoSource({ source: 'next_charge' })).toBeNull()
    expect(toSkattekontoSource({})).toBeNull()
  })
})

describe('resolveSkattekontoDueDate: everything declared due on one day', () => {
  const DUE = '2026-11-12'
  const AGI_ROW = { status: 'submitted', total_tax: 18000, total_avgifter: 12568, tax_paid_at: null }
  type Chain = Array<{ method: string; args: unknown[] }>

  /** agi_declarations by the month asked for. */
  const agiByMonth = (rows: Record<number, Record<string, unknown>>) => (calls: Chain) => {
    const month = calls.find((c) => c.method === 'eq' && c.args[0] === 'period_month')?.args[1] as number
    return { data: rows[month] ?? null }
  }

  /** The moms deadline of each period: Q3 and September (monthly, below SEK 40M) are due with the October AGI. */
  function vatDeadlines(_supabase: unknown, _companyId: string, input: { periodType: string; year: number; period: number }) {
    const due: Record<string, string> = {
      'quarterly-2026-3': DUE,
      'monthly-2026-9': DUE,
      'monthly-2026-10': '2026-12-14',
    }
    const taxPeriod =
      input.periodType === 'quarterly' ? `${input.year}-Q${input.period}` : `${input.year}-${String(input.period).padStart(2, '0')}`
    return Promise.resolve({
      tax_period: taxPeriod,
      due_date: due[`${input.periodType}-${input.year}-${input.period}`] ?? '2026-01-01',
      filed: true,
    })
  }

  beforeEach(() => {
    db.setTable('company_settings', { data: { vat_registered: true, vat_taxable_base_over_40m: false, moms_period: 'quarterly' } })
    db.setTable('agi_declarations', agiByMonth({ 10: AGI_ROW, 9: AGI_ROW }))
    vat.vatPeriodDeadline.mockImplementation(vatDeadlines)
    vat.computeVatDeclaration.mockResolvedValue(declaration({ ruta10: 96755.6, ruta48: 19351.3 }))
  })

  it('sums the quarter\'s moms and the October AGI due the same 12 November, each read by its own resolver', async () => {
    const result = await resolveSkattekontoDueDate(db.supabase as never, COMPANY, DUE, TODAY)

    expect(result).toMatchObject({
      ok: true,
      combined: {
        due_date: DUE,
        total: 107972,
        components: [
          { source: 'vat_declaration', period: '2026-Q3', amount: 77404 },
          { source: 'agi', period: '2026-10', amount: 30568 },
        ],
        excluded: [],
      },
    })
    // Only the quarter that ended before the day is placed, and computed once.
    expect(vat.vatPeriodDeadline).toHaveBeenCalledTimes(1)
    expect(vat.vatPeriodDeadline).toHaveBeenCalledWith(db.supabase, COMPANY, { periodType: 'quarterly', year: 2026, period: 3 })
    expect(vat.computeVatDeclaration).toHaveBeenCalledTimes(1)
    expect(vat.computeVatDeclaration).toHaveBeenCalledWith(db.supabase, COMPANY, 'quarterly', 2026, 3, {})
  })

  it('keeps only the periods whose own deadline is the day: the September AGI and the October moms are not due then', async () => {
    db.setTable('company_settings', { data: { vat_registered: true, vat_taxable_base_over_40m: false, moms_period: 'monthly' } })

    const result = await resolveSkattekontoDueDate(db.supabase as never, COMPANY, DUE, TODAY)

    if (!result.ok) throw new Error('expected parts')
    expect(result.combined.components.map((c) => c.period)).toEqual(['2026-09', '2026-10'])
    expect(vat.computeVatDeclaration).toHaveBeenCalledTimes(1)
    expect(vat.computeVatDeclaration).toHaveBeenCalledWith(db.supabase, COMPANY, 'monthly', 2026, 9, {})
  })

  it('leaves a refund out and reports it, never netted against the AGI', async () => {
    vat.computeVatDeclaration.mockResolvedValue(declaration({ ruta10: 1000, ruta48: 4000 }))

    const result = await resolveSkattekontoDueDate(db.supabase as never, COMPANY, DUE, TODAY)

    expect(result).toMatchObject({
      ok: true,
      combined: {
        total: 30568,
        components: [{ source: 'agi', period: '2026-10', amount: 30568 }],
        excluded: [{ source: 'vat_declaration', period: '2026-Q3', declared: -3000, reason: 'refund' }],
      },
    })
  })

  it('reads no moms for a company that does not report it, and nothing for a day without declarations', async () => {
    db.setTable('company_settings', { data: { vat_registered: false, vat_taxable_base_over_40m: false, moms_period: null } })
    let result = await resolveSkattekontoDueDate(db.supabase as never, COMPANY, DUE, TODAY)
    expect(result).toMatchObject({ ok: true, combined: { total: 30568, components: [{ source: 'agi' }] } })
    expect(vat.vatPeriodDeadline).not.toHaveBeenCalled()

    db.setTable('agi_declarations', { data: null })
    result = await resolveSkattekontoDueDate(db.supabase as never, COMPANY, DUE, TODAY)
    expect(result).toEqual({ ok: true, combined: { due_date: DUE, total: 0, components: [], excluded: [] }, parts: [] })
  })

  it('takes a declaration the caller resolved already instead of reading it again', async () => {
    const known = await resolveSkattekontoSource(db.supabase as never, COMPANY, VAT_Q3, TODAY)
    if (!known.ok) throw new Error('expected the quarter')
    vi.clearAllMocks()
    vat.vatPeriodDeadline.mockImplementation(vatDeadlines)

    const result = await resolveSkattekontoDueDate(db.supabase as never, COMPANY, DUE, TODAY, { source: VAT_Q3, due: known.due })

    expect(result).toMatchObject({ ok: true, combined: { total: 107972 } })
    expect(vat.vatPeriodDeadline).not.toHaveBeenCalled()
    expect(vat.computeVatDeclaration).not.toHaveBeenCalled()
  })

  it('refuses the day when its AGI holds one run while another is paid out in the month (crm#1768)', async () => {
    db.setTable('agi_declarations', agiByMonth({ 10: UNFILED_AGI, 9: AGI_ROW }))
    db.setTable('salary_runs', salaryRuns([OWN_LIVE, OTHER_LIVE]))

    const result = await resolveSkattekontoDueDate(db.supabase as never, COMPANY, DUE, TODAY)

    expect(result).toMatchObject({
      ok: false,
      code: 'AGI_PAYMENT_PERIOD_CONFLICT',
      details: { tax_period: '2026-10', due_date: DUE, other_salary_run_id: 'run-other' },
    })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.messageSv).toContain('hör också till redovisningsperiod 2026-10')
  })

  it('pays the day as before when the refused AGI is not due that day', async () => {
    // The September AGI holds one of two runs paid in September; it was due 12 October, not on the day.
    db.setTable('agi_declarations', agiByMonth({ 10: AGI_ROW, 9: UNFILED_AGI }))
    const september = [
      { ...OWN_LIVE, period_month: 9, payment_date: '2026-09-25' },
      { ...OTHER_LIVE, period_month: 8, payment_date: '2026-09-05' },
    ]
    db.setTable('salary_runs', (calls: Chain) => {
      const select = calls.find((c) => c.method === 'select')?.args[0]
      if (select === 'id, corrects_run_id') return { data: { id: 'run-own', corrects_run_id: null } }
      const from = calls.find((c) => c.method === 'gte')?.args[1]
      return { data: from === '2026-09-01' ? september : [] }
    })

    const result = await resolveSkattekontoDueDate(db.supabase as never, COMPANY, DUE, TODAY)

    expect(result).toMatchObject({ ok: true, combined: { total: 107972 } })
    // The September AGI was asked, and refused, but it is not the day's.
    const septemberAgi = await resolveSkattekontoSource(db.supabase as never, COMPANY, { kind: 'agi', year: 2026, month: 9 }, TODAY)
    expect(septemberAgi).toMatchObject({ ok: false, code: 'AGI_PAYMENT_PERIOD_CONFLICT', details: { due_date: '2026-10-12' } })
  })

  it('answers VAT_REPORT_GENERATION_FAILED when the moms due that day cannot be computed', async () => {
    vat.computeVatDeclaration.mockRejectedValue(new Error('no fiscal period'))
    const result = await resolveSkattekontoDueDate(db.supabase as never, COMPANY, DUE, TODAY)
    expect(result).toMatchObject({ ok: false, code: 'VAT_REPORT_GENERATION_FAILED' })
  })
})
