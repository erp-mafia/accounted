/**
 * What a declaration asks to have on the skattekonto (../skattekonto-sources.ts):
 * the momsdeklaration's ruta 49 as filed and the AGI's skatt + avgifter, with
 * the day the money must be there, and the source fields every door shares.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTableMockSupabase } from '@/tests/helpers'

const vat = vi.hoisted(() => ({ computeVatDeclaration: vi.fn(), vatPeriodDeadline: vi.fn() }))
vi.mock('@/lib/reports/vat-declaration', () => ({ computeVatDeclaration: vat.computeVatDeclaration }))
vi.mock('@/lib/vat/filing-record-store', () => ({ vatPeriodDeadline: vat.vatPeriodDeadline }))

import {
  refineSkattekontoSource,
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

  it('turns the fields into a source, and the next charge into none', () => {
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
