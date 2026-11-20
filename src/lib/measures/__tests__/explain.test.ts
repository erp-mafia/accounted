/**
 * Explanations: the contributors add up to the value, each contributor to
 * its journal lines or invoices, every line carries its typed handle, and
 * the explain handle a value answers pins the same figure.
 */
import { describe, expect, it } from 'vitest'
import { explainMeasure, getMeasure } from '../registry'
import { createFakeLedger } from './fake-ledger'
import { CO, CUS1, FP, INV1, SINV1, fixtureData } from './fixtures'

const ledger = createFakeLedger(fixtureData())
const ctx = { supabase: ledger.supabase, companyId: CO }

async function explained(id: string, params: Record<string, unknown>, page?: { limit?: number; offset?: number }) {
  const outcome = await explainMeasure(ctx, id, params, page)
  if (!outcome.ok) throw new Error(`${id} refused: ${outcome.code} ${outcome.messageSv}`)
  return outcome.data
}

const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100

describe('balance explanations', () => {
  it('accounts_receivable: the role account, its opening balance and every line to the date', async () => {
    const e = await explained('accounts_receivable', { as_of_date: '2026-06-30' })
    expect(e.value).toBe(12500)
    expect(e.contributors).toEqual([
      { kind: 'account', account_number: '1510', name: 'Kundfordringar', amount: 12500, opening_balance: 12000, role: 'accounts_receivable' },
    ])
    expect(e.drilldown.kind).toBe('journal_lines')
    expect(e.drilldown.items.map((l) => { const line = l as { journal_entry_id: string; debit: number; credit: number }; return [line.journal_entry_id, line.debit, line.credit] })).toEqual([
      ['e0000000-0000-4000-8000-000000000001', 12500, 0],
      ['e0000000-0000-4000-8000-000000000003', 0, 12000],
    ])
    expect(e.drilldown.items[0].handle).toBe('je_e0000000000040008000000000000001')
    expect(e.reconciles).toBe(true)
    expect(e.reconciliation_note).toBeNull()
  })

  it('bank_balance: one contributor per bank account, the role account marked', async () => {
    const e = await explained('bank_balance', { as_of_date: '2026-06-30' })
    expect(e.contributors.map((c) => [c.account_number, c.amount, c.role ?? null, c.cash_account_id ?? null])).toEqual([
      ['1930', 55350, 'bank', 'ca000000-0000-4000-8000-000000000001'],
      ['1940', 6250, null, 'ca000000-0000-4000-8000-000000000002'],
    ])
    expect(sum(e.contributors.map((c) => c.amount))).toBe(e.value)
    expect(e.reconciles).toBe(true)
  })

  it('liquid_funds: every 19xx account the cash position adds', async () => {
    const e = await explained('liquid_funds', { as_of_date: '2026-06-30' })
    expect(e.contributors.map((c) => c.account_number)).toEqual(['1910', '1930', '1940'])
    expect(e.reconciles).toBe(true)
  })
})

describe('income statement explanations', () => {
  it('result_to_date: revenue positive, expenses negative, lines without bokslut entries', async () => {
    const e = await explained('result_to_date', { as_of_date: '2026-12-31' })
    expect(e.value).toBe(8450)
    expect(e.contributors.find((c) => c.account_number === '5010')?.amount).toBe(-8000)
    expect(e.contributors.find((c) => c.account_number === '3001')?.amount).toBe(15000)
    expect(e.contributors.some((c) => c.account_number === '7832')).toBe(false)
    expect(e.drilldown.items.some((l) => (l as { account_number: string }).account_number === '7832')).toBe(false)
    expect(sum(e.contributors.map((c) => c.amount))).toBe(e.value)
    expect(e.reconciles).toBe(true)
  })

  it('net_revenue over a range lists only the nettoomsättning accounts', async () => {
    const e = await explained('net_revenue', { period_id: FP, from_date: '2026-04-01', to_date: '2026-06-30' })
    expect(e.value).toBe(5000)
    expect(e.contributors.map((c) => c.account_number)).toEqual(['3001'])
    expect(e.drilldown.items).toHaveLength(1)
    expect(e.reconciles).toBe(true)
  })
})

describe('vat_payable explanation', () => {
  it('names the ruta of each account and the lines the declaration reads', async () => {
    const e = await explained('vat_payable', { period_type: 'quarterly', year: 2026, period: 2 })
    expect(e.value).toBe(1150)
    expect(e.contributors.map((c) => [c.account_number, c.ruta, c.amount])).toEqual([
      ['2611', '10', 1250],
      ['2641', '48', -100],
    ])
    // The April momsredovisning (2611 debit 2 500) is not a line of the declaration.
    expect(e.drilldown.items.map((l) => (l as { journal_entry_id: string }).journal_entry_id)).toEqual([
      'e0000000-0000-4000-8000-000000000005',
      'e0000000-0000-4000-8000-000000000007',
    ])
    expect(e.reconciles).toBe(true)
  })
})

describe('invoice explanations', () => {
  it('unpaid_customer_invoices: customers with handles, invoices with inv_ handles', async () => {
    const e = await explained('unpaid_customer_invoices', {})
    expect(e.count).toBe(2)
    expect(e.contributors[0]).toMatchObject({ kind: 'customer', customer_id: CUS1, handle: 'cus_c1000000000040008000000000000001', amount: 12500 })
    expect(e.drilldown.kind).toBe('invoices')
    expect(e.drilldown.items[0]).toMatchObject({ invoice_id: INV1, handle: 'inv_a1000000000040008000000000000001', number: '1001', outstanding_sek: 12500 })
    expect(e.reconciles).toBe(true)
  })

  it('unpaid_supplier_invoices: the open supplier invoice with its sinv_ handle', async () => {
    const e = await explained('unpaid_supplier_invoices', {})
    expect(e.drilldown.kind).toBe('supplier_invoices')
    expect(e.drilldown.items).toEqual([
      expect.objectContaining({ supplier_invoice_id: SINV1, handle: 'sinv_b2000000000040008000000000000001', number: 'F-77', outstanding_sek: 10000 }),
    ])
    expect(e.reconciles).toBe(true)
  })
})

describe('paging and the explain handle', () => {
  it('pages the drill-down with limit and offset', async () => {
    const first = await explained('result_to_date', { as_of_date: '2026-06-30' }, { limit: 2 })
    expect(first.drilldown.items).toHaveLength(2)
    expect(first.drilldown).toMatchObject({ offset: 0, next_offset: 2 })
    const rest = await explained('result_to_date', { as_of_date: '2026-06-30' }, { limit: 500, offset: 2 })
    expect(rest.drilldown.next_offset).toBeNull()
    expect(first.drilldown.total).toBe(rest.drilldown.total)
    expect(rest.drilldown.items).toHaveLength(first.drilldown.total - 2)
  })

  it('pins a defaulted scope so the explanation is of the same figure', async () => {
    const value = await getMeasure(ctx, 'accounts_receivable', {}, { today: '2026-06-30' })
    expect(value.ok).toBe(true)
    if (!value.ok) return
    expect(value.data.explain).toEqual({
      tool: 'gnubok_explain_measure',
      arguments: { measure_id: 'accounts_receivable', as_of_date: '2026-06-30' },
      v1_path: `/api/v1/companies/${CO}/measures/accounts_receivable/explain?as_of_date=2026-06-30`,
    })
    const { measure_id, ...args } = value.data.explain.arguments
    const e = await explained(measure_id, args)
    expect(e.value).toBe(value.data.value)
  })

  it('pins the fiscal period of a period measure', async () => {
    const value = await getMeasure(ctx, 'net_revenue', { to_date: '2026-05-31' })
    expect(value.ok && value.data.explain.arguments).toEqual({ measure_id: 'net_revenue', period_id: FP, to_date: '2026-05-31' })
  })
})
