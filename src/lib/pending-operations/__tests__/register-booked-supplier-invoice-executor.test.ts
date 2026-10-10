/**
 * The approval of a gnubok_register_booked_supplier_invoice (crm#1094): a
 * staged create_supplier_invoice_from_inbox whose params carry mode
 * 'register_booked' must reach the registration, never the inbox conversion,
 * and must write the supplier invoice with the verifikat's rows and nothing
 * to the journal. Run through the public dispatcher.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createTableMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'
import { commitPendingOperation } from '../commit'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const SUPPLIER_ID = '33333333-3333-4333-8333-333333333333'
const VOUCHER_ID = '44444444-4444-4444-8444-444444444444'

const PARAMS = {
  mode: 'register_booked',
  supplier_id: SUPPLIER_ID,
  supplier_invoice_number: '7781',
  invoice_date: '2026-03-02',
  due_date: '2026-04-01',
  journal_entry_id: VOUCHER_ID,
  total: 10000,
  remaining_amount: 10000,
}

function op(params: Record<string, unknown> = PARAMS): PendingOperation {
  return {
    id: 'op-1',
    user_id: USER_ID,
    company_id: COMPANY_ID,
    operation_type: 'create_supplier_invoice_from_inbox',
    status: 'pending',
    title: 'Registrera bokförd leverantörsfaktura 7781',
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
    suppliers: { data: { id: SUPPLIER_ID, name: 'Leverantören AB', archived_at: null } },
    company_settings: { data: { accounting_method: 'accrual', next_arrival_number: 501 } },
    journal_entries: {
      data: { id: VOUCHER_ID, voucher_series: 'D', voucher_number: 45, entry_date: '2026-03-02', description: 'Leverantörsfaktura 7781', status: voucherStatus, source_type: 'import' },
    },
    journal_entry_lines: {
      data: [
        { account_number: '6110', debit_amount: 8000, credit_amount: 0, currency: 'SEK', line_description: null, dimensions: {} },
        { account_number: '2641', debit_amount: 2000, credit_amount: 0, currency: 'SEK', line_description: null, dimensions: {} },
        { account_number: '2440', debit_amount: 0, credit_amount: 10000, currency: 'SEK', line_description: null, dimensions: {} },
      ],
    },
    // The number lookup, the same invoice stored under a reused number, the
    // verifikat's holder lookup, then the insert.
    supplier_invoices: [{ data: [] }, { data: [] }, { data: [] }, { data: { id: 'si-1', arrival_number: 501 } }],
    supplier_invoice_items: { data: null },
    supplier_invoice_payments: { data: null },
    'rpc:get_next_arrival_number': { data: 501 },
  })
}

const writesOf = (calls: { table: string; method: string }[]) =>
  calls.filter((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.method)).map((call) => `${call.method} ${call.table}`)

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: create_supplier_invoice_from_inbox in register_booked mode', () => {
  it('registers the supplier invoice against its verifikat with its rows and posts nothing', async () => {
    const { supabase, calls, findCall } = books()
    const registered = vi.fn()
    eventBus.on('supplier_invoice.registered', registered)

    const result = await commitPendingOperation(supabase as never, USER_ID, COMPANY_ID, op())

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({
      supplier_invoice_id: 'si-1',
      supplier_invoice_number: '7781',
      payment_reference: null,
      arrival_number: 501,
      status: 'registered',
      remaining_amount: 10000,
      journal_entry_id: VOUCHER_ID,
    })
    expect(findCall('supplier_invoices', 'insert')?.[0]).toMatchObject({
      supplier_invoice_number: '7781',
      arrival_number: 501,
      status: 'registered',
      registration_journal_entry_id: VOUCHER_ID,
      paid_amount: 0,
      remaining_amount: 10000,
    })
    expect(writesOf(calls)).toEqual([
      'update pending_operations',
      'insert supplier_invoices',
      'insert supplier_invoice_items',
      'insert supplier_invoice_items',
      'update pending_operations',
    ])
    // Never the inbox conversion, never a verifikat.
    expect(calls.some((call) => call.table === 'invoice_inbox_items' || (call.table === 'journal_entries' && call.method === 'insert'))).toBe(false)
    expect(calls.filter((call) => call.table.startsWith('rpc:')).map((call) => call.table)).toEqual(['rpc:get_next_arrival_number'])
    expect(registered).toHaveBeenCalledTimes(1)
  })

  it('dates the part paid before the registration with one payment row and no verifikat', async () => {
    const { supabase, calls, findCall } = books()

    const result = await commitPendingOperation(
      supabase as never, USER_ID, COMPANY_ID, op({ ...PARAMS, remaining_amount: 4000, balance_as_of: '2026-03-31' }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ status: 'partially_paid', remaining_amount: 4000 })
    expect(findCall('supplier_invoice_payments', 'insert')?.[0]).toMatchObject({
      supplier_invoice_id: 'si-1',
      amount: 6000,
      payment_date: '2026-03-31',
      journal_entry_id: null,
    })
    expect(writesOf(calls)).toEqual([
      'update pending_operations',
      'insert supplier_invoices',
      'insert supplier_invoice_items',
      'insert supplier_invoice_items',
      'insert supplier_invoice_payments',
      'update pending_operations',
    ])
  })

  it('auto-rejects with the registry code when the verifikat was reversed after staging', async () => {
    const { supabase, findCall } = books('reversed')

    const result = await commitPendingOperation(supabase as never, USER_ID, COMPANY_ID, op())

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'SI_REGISTER_VOUCHER_NOT_POSTED',
      operation_status: 'rejected',
    })
    expect(findCall('supplier_invoices', 'insert')).toBeUndefined()
  })

  it('refuses params that were tampered with after staging', async () => {
    const { supabase, findCall } = books()

    const result = await commitPendingOperation(supabase as never, USER_ID, COMPANY_ID, op({ ...PARAMS, remaining_amount: 20000 }))

    expect(result).toMatchObject({ status: 'failed', code: 'VALIDATION_ERROR' })
    expect(findCall('supplier_invoices', 'insert')).toBeUndefined()
  })
})
