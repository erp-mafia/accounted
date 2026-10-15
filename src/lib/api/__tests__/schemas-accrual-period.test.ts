/**
 * Periodisering period rules on invoice lines: any 1-120 calendar month span,
 * except a period lying only in the invoice month (it moves nothing). The
 * supplier side refuses that here, where invoice_date is in the body; the
 * customer side refuses it in buildInvoiceWriteData (every door meets there).
 */
import { describe, expect, it } from 'vitest'
import {
  CreateInvoiceItemSchema,
  CreateSupplierInvoiceItemSchema,
  CreateSupplierInvoiceSchema,
} from '@/lib/api/schemas'

const SUPPLIER_ID = '11111111-1111-4111-8111-111111111111'

function supplierInvoice(period: { start: string; end: string }, invoiceDate = '2026-10-15') {
  return {
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: 'F-1001',
    invoice_date: invoiceDate,
    due_date: '2026-10-31',
    items: [
      {
        description: 'Lokalhyra',
        amount: 5000,
        account_number: '5010',
        vat_rate: 0.25,
        accrual_period_start: period.start,
        accrual_period_end: period.end,
        accrual_balance_account: '1710',
      },
    ],
  }
}

function issueMessages(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) {
  return (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}

describe('CreateSupplierInvoiceSchema: periodisering period', () => {
  it('accepts November only on an October invoice', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(supplierInvoice({ start: '2026-11-01', end: '2026-11-30' }))
    expect(result.success).toBe(true)
  })

  it('refuses a period lying only in the invoice month, on the row', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(supplierInvoice({ start: '2026-10-01', end: '2026-10-31' }))
    expect(result.success).toBe(false)
    expect(issueMessages(result)).toEqual([
      { path: 'items.0.accrual_period_end', message: 'Perioden måste omfatta en annan månad än fakturamånaden' },
    ])
  })

  it('accepts a period that starts on the invoice date and reaches into the next month', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(supplierInvoice({ start: '2026-10-15', end: '2026-11-14' }))
    expect(result.success).toBe(true)
  })

  it('still caps the period at 120 months', () => {
    expect(
      CreateSupplierInvoiceSchema.safeParse(supplierInvoice({ start: '2026-11-01', end: '2036-10-31' })).success,
    ).toBe(true)
    const tooLong = CreateSupplierInvoiceSchema.safeParse(supplierInvoice({ start: '2026-11-01', end: '2036-11-30' }))
    expect(tooLong.success).toBe(false)
    expect(issueMessages(tooLong)).toEqual([
      { path: 'items.0.accrual_period_end', message: 'Periodisering kan omfatta högst 120 månader' },
    ])
  })
})

describe('invoice line schemas: a one-month period passes the row rules', () => {
  it('supplier line', () => {
    const result = CreateSupplierInvoiceItemSchema.safeParse({
      description: 'Lokalhyra',
      amount: 5000,
      account_number: '5010',
      accrual_period_start: '2026-11-01',
      accrual_period_end: '2026-11-30',
    })
    expect(result.success).toBe(true)
  })

  it('customer line', () => {
    const result = CreateInvoiceItemSchema.safeParse({
      description: 'Support november',
      quantity: 1,
      unit: 'st',
      unit_price: 5000,
      vat_rate: 25,
      accrual_period_start: '2026-11-01',
      accrual_period_end: '2026-11-30',
      accrual_balance_account: '2970',
    })
    expect(result.success).toBe(true)
  })

  it('customer line still refuses more than 120 months', () => {
    const result = CreateInvoiceItemSchema.safeParse({
      description: 'Licens',
      quantity: 1,
      unit: 'st',
      unit_price: 5000,
      vat_rate: 25,
      accrual_period_start: '2026-11-01',
      accrual_period_end: '2036-11-30',
    })
    expect(result.success).toBe(false)
  })
})
