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

// accounted#113: a förutbetald intäkt (29xx) of months that ended before the
// invoice month would book them all on the invoice date.
describe('buildInvoiceWriteData: a 29xx deferral of past months', () => {
  it('refuses September on 2970 on an October invoice, naming the row and 1790', async () => {
    const result = await build([
      line({ start: '2026-11-01', end: '2026-12-31' }),
      line({ start: '2026-09-01', end: '2026-09-30' }),
    ])
    expect(result).toEqual({
      ok: false,
      code: 'INVOICE_DEFERRED_INCOME_PERIOD_PAST',
      details: { rows: [2], invoiceDate: '2026-10-15', suggestedAccount: '1790' },
    })
  })

  it('stores 1790 when the account is omitted (the form\'s suggestion), so the months book as upplupen intäkt', async () => {
    const result = await build([{ ...line({ start: '2026-08-01', end: '2026-09-30' }), accrual_balance_account: undefined }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]).toMatchObject({ accrual_balance_account: '1790' })
  })

  it('stores 2970 when the account is omitted for months from the invoice month on', async () => {
    const result = await build([{ ...line({ start: '2026-11-01', end: '2027-04-30' }), accrual_balance_account: null }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]).toMatchObject({ accrual_balance_account: '2970' })
  })

  it('keeps an overlapping period on 2970 (Sep-Nov on an October invoice)', async () => {
    const result = await build([line({ start: '2026-09-01', end: '2026-11-30' })])
    expect(result.ok).toBe(true)
  })
})
