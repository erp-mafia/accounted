import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'
import type { Customer } from '@/types'

// Real VAT rules and derivation; only the supabase lookups are mocked.
function call(supabase: SupabaseClient, customer: Customer, input: InvoiceWriteInput) {
  return buildInvoiceWriteData({ supabase, companyId: 'company-1', customer, documentType: 'invoice', input })
}

const baseHeader = {
  customer_id: 'customer-1',
  invoice_date: '2026-06-15',
  due_date: '2026-07-15',
  currency: 'SEK' as const,
}

const TJANST = 'a1000000-0000-4000-8000-000000000011'
const VARA = 'a1000000-0000-4000-8000-000000000012'
const OWN = 'a1000000-0000-4000-8000-000000000013'
const customer = makeCustomer({ customer_type: 'swedish_business' })
const articles = {
  data: [
    { id: TJANST, article_number: '1', type: 'tjanst', revenue_account: null },
    { id: VARA, article_number: '2', type: 'vara', revenue_account: null },
    { id: OWN, article_number: '3', type: 'tjanst', revenue_account: '3011' },
  ],
  error: null,
}
const chartRow = (account_number: string, account_name: string, default_vat_rate: number | null) => ({
  account_number,
  account_name,
  account_class: 3,
  default_vat_rate,
  default_vat_treatment: null,
})
const tjanstRow = { description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25, article_id: TJANST }
const varaRow = { description: 'Vara', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 25, article_id: VARA }

describe('buildInvoiceWriteData: tjänst/vara account follows the company history (crm#1661)', () => {
  it("freezes the type account the company keeps and has booked sales on, else null", async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true, fiscal_year_start_month: 1 }, error: null }) // company_settings
    enqueue({ data: [{ account_number: '3011' }], error: null }) // explicit override check
    enqueue(articles)
    enqueue({
      data: [chartRow('3041', 'Försäljning tjänster', 0.25), chartRow('3051', 'Försäljning varor 25 % moms', null)],
      error: null,
    }) // chart_of_accounts: active tjänst/vara accounts (3042 missing)
    enqueue({ data: [{ account_number: '3041', credit: '12500.00' }], error: null }) // ledger_account_days

    const result = await call(supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [
        tjanstRow,
        // 3051 is active and classified, but the company never credited it: keep the default.
        varaRow,
        // No 3042 in the chart: keep the default.
        { description: 'Konsult 12', quantity: 1, unit: 'tim', unit_price: 100, vat_rate: 12, article_id: TJANST },
        { description: 'Eget konto', quantity: 1, unit: 'tim', unit_price: 100, vat_rate: 25, article_id: OWN, revenue_account: '3011' },
        { description: 'Fri rad', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 25 },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items.map((i) => i.revenue_account)).toEqual(['3041', null, null, '3011', null])
    expect(findCall('articles', 'select')).toEqual(['id, article_number, type, revenue_account'])
    // The chart is read for the accounts the lines ask for, the history for those that pass the chart.
    expect(findCall('ledger_account_days', 'in')).toEqual(['account_number', ['3041', '3051']])
    expect(findCall('ledger_account_days', 'gte')).toEqual(['entry_date', '2025-01-01'])
    expect(findCall('ledger_account_days', 'lte')).toEqual(['entry_date', '2026-12-31'])
    expect(findCall('ledger_account_days', 'gt')).toEqual(['credit', 0])
  })

  it('keeps 3001-3003 when the company has no booking history at all', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true, fiscal_year_start_month: 1 }, error: null }) // company_settings
    enqueue({ data: [articles.data[0], articles.data[1]], error: null }) // articles
    enqueue({
      data: [chartRow('3041', 'Försäljning tjänster', 0.25), chartRow('3051', 'Försäljning varor', 0.25)],
      error: null,
    }) // chart_of_accounts
    enqueue({ data: [], error: null }) // ledger_account_days: nothing booked

    const result = await call(supabase as unknown as SupabaseClient, customer, { ...baseHeader, items: [tjanstRow, varaRow] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items.map((i) => i.revenue_account)).toEqual([null, null])
  })

  it('keeps 3001-3003 for an active account the company does not use (no credit on it)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true, fiscal_year_start_month: 1 }, error: null }) // company_settings
    enqueue({ data: [articles.data[0], articles.data[1]], error: null }) // articles
    enqueue({
      data: [chartRow('3041', 'Försäljning tjänster', 0.25), chartRow('3051', 'Försäljning varor', 0.25)],
      error: null,
    }) // chart_of_accounts
    // 3051 has sales; 3041 only carries a debit day (credit 0), which is no sale.
    enqueue({ data: [{ account_number: '3051', credit: '400' }, { account_number: '3041', credit: '0' }], error: null })

    const result = await call(supabase as unknown as SupabaseClient, customer, { ...baseHeader, items: [tjanstRow, varaRow] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items.map((i) => i.revenue_account)).toEqual([null, '3051'])
  })

  it('keeps 3001-3003 and reads no history when the account is classified at another VAT rate', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true, fiscal_year_start_month: 1 }, error: null }) // company_settings
    enqueue({ data: [articles.data[0]], error: null }) // articles
    enqueue({ data: [chartRow('3041', 'Försäljning tjänster', 0.12)], error: null }) // 12 % on the 25 % slot

    const result = await call(supabase as unknown as SupabaseClient, customer, { ...baseHeader, items: [tjanstRow] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0].revenue_account).toBeNull()
    expect(findCalls('ledger_account_days', 'select')).toEqual([])
  })

  it("reads the history over the company's räkenskapsår of the invoice date and the one before", async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true, fiscal_year_start_month: 7 }, error: null }) // brutet räkenskapsår
    enqueue({ data: [articles.data[0]], error: null }) // articles
    enqueue({ data: [chartRow('3041', 'Försäljning tjänster', 0.25)], error: null }) // chart_of_accounts
    enqueue({ data: [{ account_number: '3041', credit: '100' }], error: null }) // ledger_account_days

    const result = await call(supabase as unknown as SupabaseClient, customer, { ...baseHeader, items: [tjanstRow] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0].revenue_account).toBe('3041')
    expect(findCall('ledger_account_days', 'gte')).toEqual(['entry_date', '2024-07-01'])
    expect(findCall('ledger_account_days', 'lte')).toEqual(['entry_date', '2026-06-30'])
  })

  it('fails the write on a history read error instead of guessing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true, fiscal_year_start_month: 1 }, error: null }) // company_settings
    enqueue({ data: [articles.data[0]], error: null }) // articles
    enqueue({ data: [chartRow('3041', 'Försäljning tjänster', 0.25)], error: null }) // chart_of_accounts
    enqueue({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } })

    const result = await call(supabase as unknown as SupabaseClient, customer, { ...baseHeader, items: [tjanstRow] })

    expect(result.ok).toBe(false)
    expect(result).toHaveProperty('dbError')
  })

  it('reads no chart or history rows when no article derives its account', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null }) // company_settings
    enqueue({ data: [{ account_number: '3011' }], error: null }) // explicit override check
    enqueue({ data: [articles.data[2]], error: null }) // articles

    const result = await call(supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [
        { description: 'Eget konto', quantity: 1, unit: 'tim', unit_price: 100, vat_rate: 25, article_id: OWN, revenue_account: '3011' },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0].revenue_account).toBe('3011')
    // Only the explicit-override check reads the chart.
    expect(findCalls('chart_of_accounts', 'in')).toEqual([['account_number', ['3011']]])
    expect(findCalls('ledger_account_days', 'select')).toEqual([])
  })
})
