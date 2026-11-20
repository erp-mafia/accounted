/**
 * The approval of a gnubok_register_booked_invoice (crm#1094): a staged
 * create_invoice whose params carry mode 'register_booked' must reach the
 * registration, never the draft builder, and must write the one invoices row
 * and nothing to the journal. Run through the public dispatcher.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createTableMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'
import { commitPendingOperation } from '../commit'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333'
const VOUCHER_ID = '44444444-4444-4444-8444-444444444444'

const PARAMS = {
  mode: 'register_booked',
  customer_id: CUSTOMER_ID,
  invoice_number: '1023',
  invoice_date: '2026-03-02',
  due_date: '2026-04-01',
  journal_entry_id: VOUCHER_ID,
  total: 12500,
  remaining_amount: 12500,
}

function op(params: Record<string, unknown> = PARAMS): PendingOperation {
  return {
    id: 'op-1',
    user_id: USER_ID,
    company_id: COMPANY_ID,
    operation_type: 'create_invoice',
    status: 'pending',
    title: 'Registrera bokförd faktura 1023',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-10-09T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-09T00:00:00Z',
  } as PendingOperation
}

function books(voucherStatus = 'posted') {
  return createTableMockSupabase({
    // The atomic claim, then the terminal status write.
    pending_operations: { data: { id: 'op-1' } },
    customers: { data: { id: CUSTOMER_ID, name: 'Testkund AB', email: null } },
    company_settings: { data: { invoice_prefix: null, next_invoice_number: 2001, send_invoice_reminders: true, accounting_method: 'accrual' } },
    journal_entries: {
      data: { id: VOUCHER_ID, voucher_series: 'B', voucher_number: 45, entry_date: '2026-03-02', description: 'Kundfaktura 1023', status: voucherStatus, source_type: 'import' },
    },
    journal_entry_lines: {
      data: [
        { account_number: '1510', debit_amount: 12500, credit_amount: 0, currency: 'SEK', line_description: null },
        { account_number: '3001', debit_amount: 0, credit_amount: 10000, currency: 'SEK', line_description: null },
        { account_number: '2611', debit_amount: 0, credit_amount: 2500, currency: 'SEK', line_description: null },
      ],
    },
    invoices: [{ data: [] }, { data: [] }, { data: { id: 'inv-1' } }],
    invoice_payments: { data: { id: 'payment-1' } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: create_invoice in register_booked mode', () => {
  it('registers the invoice against its verifikat and posts nothing', async () => {
    const { supabase, calls, findCall } = books()
    const emitted = vi.fn()
    eventBus.on('invoice.created', emitted)

    const result = await commitPendingOperation(supabase as never, USER_ID, COMPANY_ID, op())

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({
      invoice_id: 'inv-1',
      invoice_number: '1023',
      status: 'sent',
      remaining_amount: 12500,
      journal_entry_id: VOUCHER_ID,
    })
    expect(findCall('invoices', 'insert')?.[0]).toMatchObject({
      invoice_number: '1023',
      status: 'sent',
      journal_entry_id: VOUCHER_ID,
      paid_amount: 0,
      remaining_amount: 12500,
    })
    const writes = calls.filter((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.method))
    expect(writes.map((call) => `${call.method} ${call.table}`)).toEqual([
      'update pending_operations',
      'insert invoices',
      'update pending_operations',
    ])
    // No draft was created, so nothing announces one.
    expect(emitted).not.toHaveBeenCalled()
  })

  it('dates the part paid before the registration with one payment row and no verifikat', async () => {
    const { supabase, calls, findCall } = books()

    const result = await commitPendingOperation(
      supabase as never, USER_ID, COMPANY_ID, op({ ...PARAMS, remaining_amount: 5000, balance_as_of: '2026-03-31' }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ status: 'partially_paid', remaining_amount: 5000 })
    expect(findCall('invoice_payments', 'insert')?.[0]).toMatchObject({
      invoice_id: 'inv-1',
      amount: 7500,
      payment_date: '2026-03-31',
      journal_entry_id: null,
    })
    const writes = calls.filter((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.method))
    expect(writes.map((call) => `${call.method} ${call.table}`)).toEqual([
      'update pending_operations',
      'insert invoices',
      'insert invoice_payments',
      'update pending_operations',
    ])
  })

  it('auto-rejects with the registry code when the verifikat was reversed after staging', async () => {
    const { supabase, findCall } = books('reversed')

    const result = await commitPendingOperation(supabase as never, USER_ID, COMPANY_ID, op())

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'INVOICE_REGISTER_VOUCHER_NOT_POSTED',
      operation_status: 'rejected',
    })
    expect(findCall('invoices', 'insert')).toBeUndefined()
  })

  it('refuses params that were tampered with after staging', async () => {
    const { supabase, findCall } = books()

    const result = await commitPendingOperation(supabase as never, USER_ID, COMPANY_ID, op({ ...PARAMS, remaining_amount: 20000 }))

    expect(result).toMatchObject({ status: 'failed', code: 'VALIDATION_ERROR' })
    expect(findCall('invoices', 'insert')).toBeUndefined()
  })
})
