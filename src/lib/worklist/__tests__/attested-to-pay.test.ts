import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { listAttestedToPayDue } from '../categories'

const ATTESTED = '2026-10-31T10:00:00Z'

const invoice = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  company_id: 'c1',
  user_id: 'alex',
  status: 'approved',
  approved_at: ATTESTED,
  due_date: '2026-11-19',
  remaining_amount: 11250,
  auto_debit: false,
  is_credit_note: false,
  currency: 'SEK',
  total: 11250,
  total_sek: null,
  exchange_rate: null,
  ...overrides,
})

function seed(invoices: unknown[], orders: unknown[]) {
  const mock = createTableMockSupabase()
  mock.setTable('company_attest_policies', {
    data: [{ company_id: 'c1', enabled: true, threshold_amount: null, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null }],
  })
  mock.setTable('company_settings', { data: [{ company_id: 'c1', accounting_method: 'accrual' }] })
  mock.setTable('supplier_invoices', { data: invoices })
  mock.setTable('payment_orders', { data: orders })
  mock.setTable('supplier_payment_batch_items', { data: [] })
  return mock.supabase as unknown as SupabaseClient
}

const shownAsFailed = (supplier_invoice_id: string) => ({
  payment_order_id: `po-${supplier_invoice_id}`,
  supplier_invoice_id,
  payee_name: 'Leverantören AB',
  supplier_invoice_number: null,
  arrival_number: 1,
  due_date: '2026-11-19',
  amount: 11250,
  currency: 'SEK',
  status: 'rejected' as const,
  reason_code: null,
  ended_at: null,
})

describe('listAttestedToPayDue (attested_to_pay)', () => {
  it('counts an attested invoice whose bank payment failed once, under payment_failed, not again here', async () => {
    const supabase = seed([invoice('refused')], [{ supplier_invoice_id: 'refused', status: 'rejected', created_at: '2026-10-30T10:00:00Z', supplier_invoice_payment_id: null }])
    // Read here the way the payment_failed row reads it.
    expect(await listAttestedToPayDue(supabase, 'c1', { today: '2026-10-31' })).toBeNull()
    // And from the list Hem already has.
    expect(await listAttestedToPayDue(supabase, 'c1', { today: '2026-10-31', paymentsFailed: [shownAsFailed('refused')] })).toBeNull()
  })

  it('keeps an invoice the payment_failed row does not show (past its scan), so none falls between the two rows', async () => {
    const supabase = seed([invoice('unscanned')], [{ supplier_invoice_id: 'unscanned', status: 'failed', created_at: '2026-10-30T10:00:00Z', supplier_invoice_payment_id: null }])
    expect(await listAttestedToPayDue(supabase, 'c1', { today: '2026-10-31', paymentsFailed: [] })).toEqual({ count: 1, next_due: '2026-11-19', overdue: 0 })
  })

  it('counts it again once a newer payment of it is made and fails no more, and counts a part-paid one', async () => {
    const supabase = seed(
      [invoice('retried'), invoice('part-paid', { status: 'partially_paid', remaining_amount: 6000, due_date: '2026-11-25' })],
      [
        { supplier_invoice_id: 'retried', status: 'rejected', created_at: '2026-10-20T10:00:00Z', supplier_invoice_payment_id: null },
        // A newer attempt, cancelled by a person: the failed one is history, the invoice is to pay.
        { supplier_invoice_id: 'retried', status: 'cancelled', created_at: '2026-10-30T10:00:00Z', supplier_invoice_payment_id: null },
      ],
    )
    expect(await listAttestedToPayDue(supabase, 'c1', { today: '2026-10-31' })).toEqual({ count: 2, next_due: '2026-11-19', overdue: 0 })
  })
})
