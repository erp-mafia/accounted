import { describe, it, expect } from 'vitest'
import {
  CreateInvoiceItemSchema,
  CreateInvoiceSchema,
  HouseworkTypeSchema,
  RotRutPayoutFileSchema,
  UpdateInvoiceSchema,
} from '../schemas'
import { DEDUCTION_LINE_ERRORS } from '@/lib/invoices/rot-rut-rules'

/**
 * The wire schemas every invoice write door shares (dashboard create/edit,
 * v1 POST/PATCH, the MCP update executor): deduction_type accepts
 * gron_teknik, refuses unknown kinds, and carries the grön teknik
 * completeness rules with field paths the editor can point at. The HUS
 * payout file stays ROT/RUT only.
 */

const UUID = '00000000-0000-4000-8000-000000000001'

const invoice = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  customer_id: UUID,
  invoice_date: '2026-09-15',
  due_date: '2026-10-15',
  currency: 'SEK' as const,
  items,
  ...extra,
})

const gronLine = (extra: Record<string, unknown> = {}) => ({
  description: 'Montage solceller',
  quantity: 1,
  unit: 'st',
  unit_price: 20000,
  deduction_type: 'gron_teknik',
  work_type: 'INSTALLATION_SOLCELLER',
  labor_hours: 24,
  ...extra,
})

const issues = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  result.success ? [] : result.error!.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))

describe('CreateInvoiceSchema: grön teknik', () => {
  it('accepts a labour row with hours and a material row without', () => {
    const result = CreateInvoiceSchema.safeParse(invoice([gronLine(), gronLine({ unit_price: 60000, labor_hours: null })]))
    expect(result.success).toBe(true)
  })

  it('refuses an unknown deduction kind', () => {
    for (const kind of ['gron', 'GRON_TEKNIK', 'green']) {
      expect(CreateInvoiceItemSchema.safeParse(gronLine({ deduction_type: kind })).success).toBe(false)
    }
  })

  it('points a missing or foreign installation type at the row', () => {
    expect(issues(CreateInvoiceSchema.safeParse(invoice([gronLine({ work_type: null })])))).toEqual([
      { path: 'items.0.work_type', message: DEDUCTION_LINE_ERRORS.gronTeknikWorkTypeMissing },
    ])
    expect(issues(CreateInvoiceSchema.safeParse(invoice([gronLine({ work_type: 'BYGG' })])))).toEqual([
      { path: 'items.0.work_type', message: DEDUCTION_LINE_ERRORS.gronTeknikWorkTypeMismatch },
    ])
  })

  it('requires hours on at least one row per installation type, anchored on its first row', () => {
    const result = CreateInvoiceSchema.safeParse(
      invoice([
        gronLine(),
        gronLine({ work_type: 'INSTALLATION_LAGRING', labor_hours: null }),
        gronLine({ work_type: 'INSTALLATION_LAGRING', labor_hours: 0 }),
      ]),
    )
    expect(issues(result)).toEqual([{ path: 'items.1.labor_hours', message: DEDUCTION_LINE_ERRORS.gronTeknikHoursMissing }])
  })

  it('refuses grön teknik and ROT on one invoice', () => {
    const rot = gronLine({ deduction_type: 'rot', work_type: 'EL', labor_hours: 2 })
    expect(issues(CreateInvoiceSchema.safeParse(invoice([rot, gronLine()])))).toEqual([
      { path: 'items.1.deduction_type', message: DEDUCTION_LINE_ERRORS.gronTeknikMixed },
    ])
  })

  it('does not apply to quotes, where the server never books a deduction', () => {
    const result = CreateInvoiceSchema.safeParse(
      invoice([gronLine({ work_type: null, labor_hours: null })], { document_type: 'quote', valid_until: '2026-10-15' }),
    )
    expect(result.success).toBe(true)
  })

  it('refuses a grön teknik row with an accrual period, naming grön teknik', () => {
    const result = CreateInvoiceItemSchema.safeParse(
      gronLine({ accrual_period_start: '2026-10-01', accrual_period_end: '2027-03-31', accrual_balance_account: '2970' }),
    )
    expect(issues(result)).toEqual(
      expect.arrayContaining([{ path: 'accrual_period_start', message: 'Rader med grön teknik kan inte periodiseras' }]),
    )
  })

  it('applies to UpdateInvoiceSchema too', () => {
    expect(UpdateInvoiceSchema.safeParse(invoice([gronLine({ labor_hours: null })])).success).toBe(false)
    expect(UpdateInvoiceSchema.safeParse(invoice([gronLine()])).success).toBe(true)
  })
})

describe('RotRutPayoutFileSchema: the HUS file stays ROT/RUT', () => {
  it('refuses gron_teknik and keeps rot and rut', () => {
    const body = (deduction_type: string) => ({ deduction_type, invoice_ids: [UUID] })
    expect(RotRutPayoutFileSchema.safeParse(body('gron_teknik')).success).toBe(false)
    expect(RotRutPayoutFileSchema.safeParse(body('rot')).success).toBe(true)
    expect(RotRutPayoutFileSchema.safeParse(body('rut')).success).toBe(true)
  })
})

describe('HouseworkTypeSchema: articles can carry an installation type', () => {
  it('accepts and upper-cases the grön teknik codes', () => {
    expect(HouseworkTypeSchema.parse('installation_lagring')).toBe('INSTALLATION_LAGRING')
    expect(HouseworkTypeSchema.parse('INSTALLATION_SOLCELLER')).toBe('INSTALLATION_SOLCELLER')
  })

  it('still refuses a bare grön teknik kind and lists the installation codes in its message', () => {
    const result = HouseworkTypeSchema.safeParse('GRON_TEKNIK')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].message).toContain('INSTALLATION_LADDPUNKT')
  })
})
