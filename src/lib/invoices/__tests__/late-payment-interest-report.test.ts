import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getLatePaymentInterestReport } from '../late-payment-interest-report'

const { supabase, enqueue, enqueueMany, reset, findCall, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const AS_OF = '2026-10-26'

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    invoice_number: '1042',
    external_invoice_number: null,
    due_date: '2026-09-01',
    currency: 'SEK',
    status: 'paid',
    document_type: 'invoice',
    credited_invoice_id: null,
    customer: { name: 'Kund AB' },
    ...overrides,
  }
}

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    invoice_id: 'inv-1',
    payment_date: '2026-09-21',
    amount: 12_500,
    journal_entry: { source_type: 'invoice_paid' },
    invoice: invoice(),
    ...overrides,
  }
}

function run(payments: unknown[], openInvoices: unknown[] = [], override: number | null = null) {
  enqueueMany([
    { data: { reminder_interest_rate_override: override } },
    { data: payments },
    { data: openInvoices },
  ])
  return getLatePaymentInterestReport(client, 'company-1', AS_OF)
}

describe('getLatePaymentInterestReport', () => {
  beforeEach(() => reset())

  it('charges a payment booked after the due date at referensränta + 8 pp', async () => {
    const report = await run([payment()])

    // 12 500 × 0.10 × 20 / 365 = 68.49
    expect(report.paid_late).toEqual([
      {
        invoice_id: 'inv-1',
        invoice_number: '1042',
        customer_name: 'Kund AB',
        currency: 'SEK',
        due_date: '2026-09-01',
        paid_late_amount: 12_500,
        last_payment_date: '2026-09-21',
        days_late: 20,
        interest: 68.49,
      },
    ])
    expect(report.rate).toBeCloseTo(0.1, 6)
    expect(report.rate_is_override).toBe(false)
    expect(report.totals).toEqual([{ currency: 'SEK', paid_late_interest: 68.49, overdue_interest: 0 }])
  })

  it('reads only this company, payments with a verifikat, up to as_of', async () => {
    await run([])
    expect(findCall('invoice_payments', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('invoice_payments', 'not')).toEqual(['journal_entry_id', 'is', null])
    expect(findCall('invoice_payments', 'lte')).toEqual(['payment_date', AS_OF])
    expect(findCalls('invoices', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCall('company_settings', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('leaves out payments whose verifikat came with an import, and other non-payments', async () => {
    const report = await run([
      payment({ id: 'p-import', journal_entry: { source_type: 'import' } }),
      payment({ id: 'p-opening', journal_entry: { source_type: 'opening_balance' } }),
      payment({ id: 'p-credit', journal_entry: { source_type: 'credit_note' } }),
      payment({ id: 'p-loss', journal_entry: { source_type: 'customer_loss' } }),
      payment({ id: 'p-collected', journal_entry: { source_type: 'collection_settlement' } }),
      payment({ id: 'p-none', journal_entry: null }),
    ])
    expect(report.paid_late).toEqual([])
    expect(report.totals).toEqual([])
  })

  it('does not list a payment made on or before the due date', async () => {
    const report = await run([payment({ payment_date: '2026-09-01' }), payment({ id: 'p-early', payment_date: '2026-08-20' })])
    expect(report.paid_late).toEqual([])
  })

  it('charges only the part that was paid late, per payment', async () => {
    const report = await run([
      payment({ id: 'p-on-time', payment_date: '2026-08-30', amount: 10_000 }),
      // 2 500 × 0.10 × 10 / 365 = 6.849...
      payment({ id: 'p-late-1', payment_date: '2026-09-11', amount: 2_500 }),
      // 3 650 × 0.10 × 30 / 365 = 30.00
      payment({ id: 'p-late-2', payment_date: '2026-10-01', amount: 3_650 }),
    ])
    expect(report.paid_late).toHaveLength(1)
    expect(report.paid_late[0]).toMatchObject({
      paid_late_amount: 6_150,
      last_payment_date: '2026-10-01',
      days_late: 30,
      interest: 36.85,
    })
  })

  it('skips credit notes, quotes and other document types', async () => {
    const report = await run([
      payment({ invoice: invoice({ credited_invoice_id: 'inv-0' }) }),
      payment({ id: 'p-imported', invoice: invoice({ id: 'cn-1', total: -500 } as never) }),
      payment({ id: 'p-quote', invoice: invoice({ id: 'q-1', document_type: 'quote' }) }),
    ])
    expect(report.paid_late).toEqual([])
  })

  it('accrues interest on an overdue open invoice up to as_of', async () => {
    const report = await run(
      [],
      [invoice({ id: 'inv-open', invoice_number: '1050', status: 'sent', due_date: '2026-10-16', remaining_amount: '3650.00' })],
    )
    // 3 650 × 0.10 × 10 / 365 = 10.00
    expect(report.overdue_open).toEqual([
      {
        invoice_id: 'inv-open',
        invoice_number: '1050',
        customer_name: 'Kund AB',
        currency: 'SEK',
        due_date: '2026-10-16',
        remaining_amount: 3650,
        days_overdue: 10,
        interest: 10,
      },
    ])
    expect(report.totals).toEqual([{ currency: 'SEK', paid_late_interest: 0, overdue_interest: 10 }])
    expect(findCall('invoices', 'lt')).toEqual(['due_date', AS_OF])
    expect(findCall('invoices', 'in')).toEqual(['status', ['sent', 'overdue', 'partially_paid']])
  })

  it("uses the company's own rate flat when it set one", async () => {
    const report = await run([payment()], [], 0.12)
    // 12 500 × 0.12 × 20 / 365 = 82.19
    expect(report.paid_late[0].interest).toBe(82.19)
    expect(report.rate).toBe(0.12)
    expect(report.rate_is_override).toBe(true)
  })

  it('holds a private person at the consumer ceiling and says so', async () => {
    const privatePerson = invoice({ id: 'inv-p', customer: { name: 'Anna', customer_type: 'individual' } })
    const report = await run([payment({ id: 'p-p', invoice_id: 'inv-p', invoice: privatePerson }), payment()], [], 0.25)
    const byInvoice = Object.fromEntries(report.paid_late.map((row) => [row.invoice_id, row.interest]))
    // Ceiling 2% + 20 = 22%: 12 500 × 0.22 × 20 / 365 = 150.68
    expect(byInvoice['inv-p']).toBe(150.68)
    // The company debtor pays the agreed 25%: 12 500 × 0.25 × 20 / 365 = 171.23
    expect(byInvoice['inv-1']).toBe(171.23)
    expect(report.rate).toBe(0.25)
    expect(report.consumer_rate_ceiling).toBe(0.22)
  })

  it('reports no ceiling when the own rate is under it', async () => {
    const report = await run([payment()], [], 0.12)
    expect(report.consumer_rate_ceiling).toBeNull()
  })

  it('keeps each currency apart in the totals', async () => {
    const report = await run([
      payment({ id: 'p-eur', invoice: invoice({ id: 'inv-eur', currency: 'EUR' }), amount: 1_000 }),
      payment(),
    ])
    expect(report.totals.map((t) => t.currency)).toEqual(['EUR', 'SEK'])
    expect(report.paid_late.find((r) => r.currency === 'EUR')?.interest).toBe(5.48)
  })

  it('surfaces a database error instead of an empty list', async () => {
    enqueue({ data: null, error: { message: 'boom', code: '57014' } })
    await expect(getLatePaymentInterestReport(client, 'company-1', AS_OF)).rejects.toThrow()
  })
})
