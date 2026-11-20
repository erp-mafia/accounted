/**
 * An invoice is past due only from the Swedish day after its due date. The
 * same three moments through every door: daytime on the due date, the UTC
 * midnight that opens it, and the first night hours of the next Swedish day.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPastDue, todayIsoStockholm } from '@/lib/dates/iso'
import { isInvoiceOverdue } from '@/lib/invoices/overdue'
import { isOverduePayable } from '@/lib/supplier-invoices/lifecycle'
import { restoredAfterUncredit } from '@/lib/supplier-invoices/manage'
import { customerLossMenuVisible } from '@/lib/customer-loss/eligibility'
import { isDeadlineOverdue } from '@/lib/calendar/utils'
import { syncInvoiceStatusFromPaymentEntry } from '@/lib/bookkeeping/payment-sync'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { JournalEntry } from '@/types'

const DUE = '2026-11-02'
const ON_THE_DUE_DATE = ['2026-11-02T00:30:00Z', '2026-11-02T10:00:00Z']
/** 00:30 on 3 November in Sweden, still the due date in UTC. */
const THE_NIGHT_AFTER = '2026-11-02T23:30:00Z'

afterEach(() => {
  vi.useRealTimers()
})

function at(instant: string) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(instant))
}

async function statusAfterStorno(sourceType: string, table: string): Promise<unknown> {
  const { supabase, enqueue, findCall } = createQueuedMockSupabase()
  enqueue({ data: [{ id: 'pay-1', amount: 1000, transaction_id: null }] }) // the payment rows
  enqueue({ data: [] }) // no bank line
  enqueue({ data: { paid_amount: 1000, total: 1000, due_date: DUE } }) // the invoice
  enqueue({ data: null }) // the status write
  enqueue({ data: null }) // the payment row's delete
  const entry = { id: 'je-1', source_type: sourceType, source_id: 'invoice-1' } as unknown as JournalEntry
  await syncInvoiceStatusFromPaymentEntry(supabase as never, 'company-1', entry)
  return (findCall(table, 'update')?.[0] as { status?: unknown } | undefined)?.status
}

/** Each door's answer to "is it past due?" with the clock where the test put it. */
const DOORS: Record<string, () => unknown> = {
  isPastDue: () => isPastDue(DUE, todayIsoStockholm()),
  isInvoiceOverdue: () => isInvoiceOverdue({ status: 'sent', due_date: DUE, remaining_amount: 100 }, todayIsoStockholm()),
  isOverduePayable: () => isOverduePayable({ due_date: DUE, remaining_amount: 100 }, todayIsoStockholm()),
  'the uncredit of a supplier invoice': () => {
    const original = { total: 100, due_date: DUE, registration_journal_entry_id: 'je-1' }
    return restoredAfterUncredit(original as never, [], new Date()).status === 'overdue'
  },
  'a supplier payment storno': async () => (await statusAfterStorno('supplier_invoice_paid', 'supplier_invoices')) === 'overdue',
  'a customer payment storno': async () => (await statusAfterStorno('invoice_paid', 'invoices')) === 'overdue',
}

describe.each(ON_THE_DUE_DATE)('on the due date, at %s', (instant) => {
  it.each(Object.keys(DOORS))('%s says on time', async (door) => {
    at(instant)
    expect(todayIsoStockholm()).toBe(DUE)
    expect(await DOORS[door]()).toBe(false)
  })
})

describe('the night after: the Swedish day has moved on and UTC has not', () => {
  it.each(Object.keys(DOORS))('%s says past due', async (door) => {
    at(THE_NIGHT_AFTER)
    expect(todayIsoStockholm()).toBe('2026-11-03')
    expect(await DOORS[door]()).toBe(true)
  })
})

describe('a deadline follows the same test', () => {
  const deadline = { due_date: DUE, is_completed: false } as never

  it('on its day it is not overdue, the night after it is', () => {
    at('2026-11-02T10:00:00Z')
    expect(isDeadlineOverdue(deadline)).toBe(false)
    at(THE_NIGHT_AFTER)
    expect(isDeadlineOverdue(deadline)).toBe(true)
  })
})

describe('the kundförlust menu reads the date, not a stored label', () => {
  const invoice = { status: 'overdue', currency: 'SEK', remaining_amount: 100, document_type: 'invoice', credited_invoice_id: null }

  it('a stored overdue with a due date moved ahead is not overdue', () => {
    expect(customerLossMenuVisible({ ...invoice, due_date: '2026-12-01' } as never, null, '2026-11-01')).toBe(false)
  })

  it('on the due date the menu stays away, the day after it shows', () => {
    const sent = { ...invoice, status: 'sent', due_date: DUE }
    expect(customerLossMenuVisible(sent as never, null, DUE)).toBe(false)
    expect(customerLossMenuVisible(sent as never, null, '2026-11-03')).toBe(true)
  })
})

describe('the live reskontra ages from the Swedish day', () => {
  const row = { id: 'i1', invoice_number: 'F1', invoice_date: '2026-10-01', due_date: DUE, total: 1000, paid_amount: 0, currency: 'SEK', status: 'sent' }
  let tables: ReskontraTables
  const { supabase } = createReskontraClient(() => tables, () => ({}))

  it('kundreskontra: the day after the due date is day one', async () => {
    tables = { invoices: [{ ...row, customer_id: 'c1', customer: { id: 'c1', name: 'Kund AB' } }] }
    at(THE_NIGHT_AFTER)
    const report = await generateARLedger(supabase, 'company-1')
    expect(report.entries[0].days_1_30).toBe(1000)
    expect(report.entries[0].invoices[0].days_overdue).toBe(1)
  })

  it('kundreskontra: on the due date it is current', async () => {
    tables = { invoices: [{ ...row, customer_id: 'c1', customer: { id: 'c1', name: 'Kund AB' } }] }
    at('2026-11-02T22:30:00Z')
    const report = await generateARLedger(supabase, 'company-1')
    expect(report.entries[0].current).toBe(1000)
  })

  it('leverantörsreskontra: the day after the due date is day one', async () => {
    tables = {
      supplier_invoices: [{
        ...row, supplier_invoice_number: 'L1', arrival_number: 1, supplier_id: 's1', supplier: { id: 's1', name: 'Lev AB' },
        status: 'approved', remaining_amount: 1000, is_credit_note: false,
      }],
    }
    at(THE_NIGHT_AFTER)
    const report = await generateSupplierLedger(supabase as never, 'company-1', undefined, { includeInvoices: true })
    expect(report.entries[0].days_1_30).toBe(1000)
    expect(report.entries[0].invoices?.[0].days_overdue).toBe(1)
  })
})
