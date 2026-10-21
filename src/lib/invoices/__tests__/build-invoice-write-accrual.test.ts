/**
 * Periodisering in the shared invoice builder, the point every customer
 * invoice door reaches with its effective invoice date and rows (web, v1
 * create and PATCH, bulk-create, MCP create and update, sales orders): a
 * one-month period in another month than the invoice month is kept, a period
 * lying only in the invoice month is refused. Only supabase is mocked.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import { buildInvoiceWriteData, type InvoiceWriteItemInput } from '@/lib/invoices/build-invoice-write'

const customer = makeCustomer({ customer_type: 'swedish_business', country: 'SE' })

function line(period: { start: string; end: string }, account = '2970'): InvoiceWriteItemInput {
  return {
    description: 'Support november',
    quantity: 1,
    unit: 'st',
    unit_price: 5000,
    vat_rate: 25,
    accrual_period_start: period.start,
    accrual_period_end: period.end,
    accrual_balance_account: account,
  }
}

async function build(items: InvoiceWriteItemInput[], invoiceDate = '2026-10-15') {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: { vat_registered: true } }) // company_settings.vat_registered
  enqueue({ data: { accounting_method: 'accrual' } }) // company_settings.accounting_method
  return buildInvoiceWriteData({
    supabase: supabase as unknown as SupabaseClient,
    companyId: 'company-1',
    customer,
    documentType: 'invoice',
    input: {
      customer_id: 'customer-1',
      invoice_date: invoiceDate,
      due_date: '2026-11-14',
      currency: 'SEK',
      items,
    },
  })
}

describe('buildInvoiceWriteData: one-month periodisering', () => {
  it('keeps November only on an October invoice', async () => {
    const result = await build([line({ start: '2026-11-01', end: '2026-11-30' })])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]).toMatchObject({
      accrual_period_start: '2026-11-01',
      accrual_period_end: '2026-11-30',
      accrual_balance_account: '2970',
      line_total: 5000,
    })
  })

  it('refuses a period lying only in the invoice month and names the row', async () => {
    const result = await build([
      line({ start: '2026-11-01', end: '2026-11-30' }),
      line({ start: '2026-10-01', end: '2026-10-31' }),
    ])
    expect(result).toEqual({
      ok: false,
      code: 'INVOICE_CREATE_ACCRUAL_INVOICE_MONTH',
      details: { rows: [2], invoiceDate: '2026-10-15' },
    })
  })

  it('judges the effective invoice date: an edit moving the date into the period month is refused', async () => {
    const result = await build([line({ start: '2026-11-01', end: '2026-11-30' })], '2026-11-03')
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_CREATE_ACCRUAL_INVOICE_MONTH' })
  })
})

// Upplupen intäkt (17xx, #62): revenue of months before the invoice month.
describe('buildInvoiceWriteData: upplupen intäkt (17xx)', () => {
  it('keeps August-September on 1790 on an October invoice', async () => {
    const result = await build([line({ start: '2026-08-01', end: '2026-09-30' }, '1790')])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]).toMatchObject({
      accrual_period_start: '2026-08-01',
      accrual_period_end: '2026-09-30',
      accrual_balance_account: '1790',
      line_total: 5000,
    })
  })

  it('refuses a 17xx period that reaches the invoice month and names the row', async () => {
    const result = await build([
      line({ start: '2026-08-01', end: '2026-09-30' }, '1790'),
      line({ start: '2026-09-01', end: '2026-12-31' }, '1790'),
    ])
    expect(result).toEqual({
      ok: false,
      code: 'INVOICE_ACCRUED_INCOME_PERIOD_INVALID',
      details: { rows: [2], invoiceDate: '2026-10-15' },
    })
  })

  it('keeps the same period on 29xx (a förutbetald intäkt from the invoice on)', async () => {
    const result = await build([line({ start: '2026-09-01', end: '2026-12-31' })])
    expect(result.ok).toBe(true)
  })
})
