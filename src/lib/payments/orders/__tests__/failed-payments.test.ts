import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { listInvoicesAfterFailedPayment } from '../failed-payments'

const COMPANY = 'company-1'

function failedOrder(id: string, invoiceId: string, createdAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    supplier_invoice_id: invoiceId,
    status: 'rejected',
    amount: '4200.00',
    currency: 'SEK',
    payee_name: 'Derome Bygg AB',
    provider_error_code: 'PSU_RIGHTS_MISSING',
    provider_status_at: '2026-10-20T09:00:43Z',
    created_at: createdAt,
    ...overrides,
  }
}

function invoice(id: string, status: string, dueDate = '2026-10-11') {
  return { id, status, supplier_invoice_number: `F-${id}`, arrival_number: 12, due_date: dueDate }
}

/** payment_orders answers the failed read first, then every order of the invoices. */
function database(failed: unknown[], allOrders: unknown[], invoices: unknown[]) {
  return createTableMockSupabase({
    payment_orders: [{ data: failed }, { data: allOrders }],
    supplier_invoices: { data: invoices },
  })
}

async function list(db: ReturnType<typeof createTableMockSupabase>) {
  return listInvoicesAfterFailedPayment(db.supabase as unknown as SupabaseClient, COMPANY)
}

describe('listInvoicesAfterFailedPayment', () => {
  it('lists an unpaid invoice whose newest bank payment the bank rejected, with the bank reason (the production case: two attempts, both rejected)', async () => {
    const older = failedOrder('o1', 'inv-1', '2026-10-20T08:50:35Z')
    const newer = failedOrder('o2', 'inv-1', '2026-10-20T08:51:32Z')
    const db = database([newer, older], [older, newer], [invoice('inv-1', 'overdue')])

    expect(await list(db)).toEqual([
      {
        payment_order_id: 'o2',
        supplier_invoice_id: 'inv-1',
        payee_name: 'Derome Bygg AB',
        supplier_invoice_number: 'F-inv-1',
        arrival_number: 12,
        due_date: '2026-10-11',
        amount: 4200,
        currency: 'SEK',
        status: 'rejected',
        reason_code: 'PSU_RIGHTS_MISSING',
        ended_at: '2026-10-20T09:00:43Z',
      },
    ])
    expect(db.findCall('payment_orders', 'in')).toEqual(['status', ['rejected', 'failed']])
    expect(db.findCall('payment_orders', 'eq')).toEqual(['company_id', COMPANY])
  })

  it('drops an invoice paid again with a newer payment, whatever became of that one', async () => {
    const failed = failedOrder('o1', 'inv-1', '2026-10-23T18:10:53Z')
    const retry = { id: 'o2', supplier_invoice_id: 'inv-1', created_at: '2026-10-24T07:00:00Z' }
    const db = database([failed], [failed, retry], [invoice('inv-1', 'approved')])

    expect(await list(db)).toEqual([])
  })

  it('drops an invoice that is paid, credited or settled another way', async () => {
    const paid = failedOrder('o1', 'inv-1', '2026-10-21T07:59:01Z')
    const credited = failedOrder('o2', 'inv-2', '2026-10-21T08:00:00Z', { status: 'failed', provider_error_code: 'FORMAT_ERROR' })
    const db = database([credited, paid], [paid, credited], [invoice('inv-1', 'paid'), invoice('inv-2', 'credited')])

    expect(await list(db)).toEqual([])
  })

  it('puts the most pressing due date first', async () => {
    const late = failedOrder('o1', 'inv-late', '2026-10-20T08:00:00Z')
    const soon = failedOrder('o2', 'inv-soon', '2026-10-21T08:00:00Z')
    const db = database([soon, late], [late, soon], [invoice('inv-late', 'approved', '2026-11-30'), invoice('inv-soon', 'registered', '2026-11-02')])

    expect((await list(db)).map((row) => row.supplier_invoice_id)).toEqual(['inv-soon', 'inv-late'])
  })

  it('reads nothing more when no payment failed', async () => {
    const db = database([], [], [])

    expect(await list(db)).toEqual([])
    expect(db.tables()).toEqual(['payment_orders'])
  })

  it('throws a failed read, for the worklist to soft-fail', async () => {
    const db = createTableMockSupabase({ payment_orders: { error: { message: 'boom', code: 'XX000' } } })

    await expect(list(db)).rejects.toMatchObject({ message: 'boom' })
  })
})
