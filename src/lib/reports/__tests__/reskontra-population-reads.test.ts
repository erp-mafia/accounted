import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchArLedgerInvoices } from '../ar-ledger-invoices'
import { fetchSupplierLedgerInvoices } from '../supplier-ledger-invoices'

function client(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result)
  return { supabase: { rpc } as unknown as SupabaseClient, rpc }
}

describe('fetchArLedgerInvoices', () => {
  it('reads the live population, or one customer as of a date', async () => {
    const { supabase, rpc } = client({ data: [{ id: 'inv-1' }], error: null })

    expect(await fetchArLedgerInvoices(supabase, 'company-1')).toEqual([{ id: 'inv-1' }])
    await fetchArLedgerInvoices(supabase, 'company-1', { asOfDate: '2026-06-30', customerId: 'cust-1' })

    expect(rpc.mock.calls).toEqual([
      ['get_ar_ledger_invoices', { p_company_id: 'company-1', p_as_of_date: null, p_customer_id: null }],
      ['get_ar_ledger_invoices', { p_company_id: 'company-1', p_as_of_date: '2026-06-30', p_customer_id: 'cust-1' }],
    ])
  })

  it('throws a failed read with its SQLSTATE, so a timeout stays retryable', async () => {
    const { supabase } = client({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } })

    await expect(fetchArLedgerInvoices(supabase, 'company-1')).rejects.toMatchObject({
      code: '57014',
      message: expect.stringContaining('statement timeout'),
    })
  })

  it('reads an empty answer as no invoices', async () => {
    const { supabase } = client({ data: null, error: null })
    expect(await fetchArLedgerInvoices(supabase, 'company-1')).toEqual([])
  })
})

describe('fetchSupplierLedgerInvoices', () => {
  it('reads the live population, or one supplier as of a date', async () => {
    const { supabase, rpc } = client({ data: [{ id: 'si-1' }], error: null })

    expect(await fetchSupplierLedgerInvoices(supabase, 'company-1')).toEqual([{ id: 'si-1' }])
    await fetchSupplierLedgerInvoices(supabase, 'company-1', { asOfDate: '2026-06-30', supplierId: 'sup-1' })

    expect(rpc.mock.calls).toEqual([
      ['get_supplier_ledger_invoices', { p_company_id: 'company-1', p_as_of_date: null, p_supplier_id: null }],
      ['get_supplier_ledger_invoices', { p_company_id: 'company-1', p_as_of_date: '2026-06-30', p_supplier_id: 'sup-1' }],
    ])
  })

  it('throws a failed read with its SQLSTATE', async () => {
    const { supabase } = client({ data: null, error: { message: 'permission denied', code: '42501' } })
    await expect(fetchSupplierLedgerInvoices(supabase, 'company-1')).rejects.toMatchObject({ code: '42501' })
  })
})
