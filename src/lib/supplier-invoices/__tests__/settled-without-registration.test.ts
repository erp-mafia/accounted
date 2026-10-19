/**
 * listSettledWithoutRegistration: the read-only list of a deferring company's
 * supplier invoices a payment settled before the registration-first rule, for
 * a later reviewed repair. It writes nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { listSettledWithoutRegistration } from '../settled-without-registration'

let db: ReturnType<typeof createQueuedMockSupabase>
const run = () => listSettledWithoutRegistration(db.supabase as unknown as SupabaseClient, 'company-1')

const invoice = (id: string, status = 'paid') => ({
  id,
  arrival_number: 7,
  supplier_invoice_number: `LF-${id}`,
  invoice_date: '2026-08-01',
  status,
  currency: 'SEK',
  total: 1250,
  paid_amount: 1250,
})

beforeEach(() => {
  db = createQueuedMockSupabase()
})

describe('listSettledWithoutRegistration', () => {
  it('reads nothing more for a company that does not book in a separate step', async () => {
    db.enqueue({ data: { accounting_method: 'accrual', defer_invoice_booking: false } })
    await expect(run()).resolves.toEqual([])
    db.enqueue({ data: { accounting_method: 'cash', defer_invoice_booking: true } })
    await expect(run()).resolves.toEqual([])
    expect(db.findCalls('supplier_invoices', 'select')).toHaveLength(0)
  })

  it('lists paid invoices whose payment cleared 2440 with no registration, and skips cash entries', async () => {
    db.enqueue({ data: { accounting_method: 'accrual', defer_invoice_booking: true } })
    db.enqueue({ data: [invoice('si-1'), invoice('si-2', 'partially_paid'), invoice('si-3')] })
    db.enqueue({
      data: [
        { id: 'p-1', supplier_invoice_id: 'si-1', journal_entry_id: 'je-clear-1' },
        { id: 'p-2', supplier_invoice_id: 'si-2', journal_entry_id: 'je-clear-2' },
        { id: 'p-3', supplier_invoice_id: 'si-3', journal_entry_id: 'je-cash-3' },
      ],
    })
    db.enqueue({
      data: [
        { id: 'je-clear-1', source_type: 'supplier_invoice_paid', status: 'posted' },
        { id: 'je-clear-2', source_type: 'supplier_invoice_paid', status: 'posted' },
        { id: 'je-cash-3', source_type: 'supplier_invoice_cash_payment', status: 'posted' },
      ],
    })

    const listed = await run()

    expect(listed.map((row) => row.supplier_invoice_id)).toEqual(['si-1', 'si-2'])
    expect(listed[0]).toEqual({
      supplier_invoice_id: 'si-1',
      arrival_number: 7,
      supplier_invoice_number: 'LF-si-1',
      invoice_date: '2026-08-01',
      status: 'paid',
      currency: 'SEK',
      total: 1250,
      paid_amount: 1250,
      payment_journal_entry_ids: ['je-clear-1'],
    })
    // Only unbooked, non-credit, paid or partially paid invoices are read.
    expect(db.findCalls('supplier_invoices', 'is')).toContainEqual(['registration_journal_entry_id', null])
    expect(db.findCalls('supplier_invoices', 'eq')).toContainEqual(['is_credit_note', false])
    expect(db.findCalls('supplier_invoices', 'in')).toContainEqual(['status', ['paid', 'partially_paid']])
    // Read-only.
    for (const method of ['insert', 'update', 'upsert', 'delete', 'rpc']) {
      expect(db.calls.some((c) => c.method === method)).toBe(false)
    }
  })

  it('throws on a read error rather than answer a short list', async () => {
    db.enqueue({ data: null, error: { message: 'timeout' } })
    await expect(run()).rejects.toBeTruthy()
  })
})
