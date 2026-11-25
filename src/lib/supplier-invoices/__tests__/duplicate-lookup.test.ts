import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  lookupSupplierInvoiceDuplicates,
  readDuplicateNumberHolder,
  referenceReuseNeedsAcknowledgement,
  registeredInvoicePayment,
} from '../duplicate-lookup'
import { duplicateLookupQuery, registrationPassesReview, type DuplicateLookupFields } from '../duplicate-lookup-query'
import { createSupplierInvoiceRowsDb, invoiceRow, voucherRow } from './supplier-invoice-rows-db'

type Row = Record<string, unknown>

function lookup(
  tables: { supplier_invoices: Row[]; journal_entries?: Row[]; payment_orders?: Row[]; supplier_payment_batch_items?: Row[] },
  input: { number?: string; reference?: string; invoiceDate?: string; total?: number; currency?: string },
) {
  const db = createSupplierInvoiceRowsDb({ journal_entries: [], payment_orders: [], supplier_payment_batch_items: [], ...tables })
  const found = lookupSupplierInvoiceDuplicates(db.supabase as unknown as SupabaseClient, 'company-1', {
    supplierId: 'supplier-1',
    ...input,
  })
  return { db, found }
}

describe('referenceReuseNeedsAcknowledgement', () => {
  it.each([
    [0, false],
    [1, true],
    [2, false],
    [7, false],
  ])('%i other invoice(s) on the reference: %s', (count, expected) => {
    expect(referenceReuseNeedsAcknowledgement(count)).toBe(expected)
  })
})

describe('duplicateLookupQuery', () => {
  const fields = (overrides: Partial<DuplicateLookupFields> = {}): DuplicateLookupFields => ({
    supplier_id: 'supplier-1',
    supplier_invoice_number: '',
    payment_reference: '',
    payer: 'unpaid',
    ...overrides,
  })

  it('asks nothing without a supplier: one being created inline has no id yet', () => {
    expect(duplicateLookupQuery(fields({ supplier_id: '', supplier_invoice_number: 'F-1', payment_reference: '12345' }))).toBeNull()
  })

  it('asks nothing with neither a number nor a reference', () => {
    expect(duplicateLookupQuery(fields({ supplier_invoice_number: '  ' }))).toBeNull()
  })

  it('asks the number, the reference or both, trimmed', () => {
    expect(duplicateLookupQuery(fields({ supplier_invoice_number: ' F-1 ' }))).toBe('supplier_id=supplier-1&number=F-1')
    expect(duplicateLookupQuery(fields({ payment_reference: ' 1234 5678 ' }))).toBe(
      'supplier_id=supplier-1&reference=1234+5678',
    )
    expect(duplicateLookupQuery(fields({ supplier_invoice_number: 'F-1', payment_reference: '12345678', payer: 'company' }))).toBe(
      'supplier_id=supplier-1&number=F-1&reference=12345678',
    )
  })

  it('leaves out a reference without a digit: free text names no payment', () => {
    expect(duplicateLookupQuery(fields({ supplier_invoice_number: 'F-1', payment_reference: 'enligt avtal' }))).toBe(
      'supplier_id=supplier-1&number=F-1',
    )
    expect(duplicateLookupQuery(fields({ payment_reference: 'enligt avtal' }))).toBeNull()
  })

  it('sends the date, the amount to pay and the currency along with a reference: they tell the same document again', () => {
    expect(
      duplicateLookupQuery(
        fields({ supplier_invoice_number: 'F-1', payment_reference: '12345678', invoice_date: '2026-11-05', total: 2185, currency: 'EUR' }),
      ),
    ).toBe('supplier_id=supplier-1&number=F-1&reference=12345678&invoice_date=2026-11-05&total=2185&currency=EUR')
    expect(duplicateLookupQuery(fields({ payment_reference: '12345678', invoice_date: '2026-11-05', total: 4999.5 }))).toBe(
      'supplier_id=supplier-1&reference=12345678&invoice_date=2026-11-05&total=4999.5&currency=SEK',
    )
  })

  it('sends no date or amount in a currency no invoice is registered in: the route would refuse the whole lookup', () => {
    expect(duplicateLookupQuery(fields({ payment_reference: '12345678', invoice_date: '2026-11-05', total: 2185, currency: 'PLN' }))).toBe(
      'supplier_id=supplier-1&reference=12345678',
    )
  })

  it('sends no date or amount without a reference, or before the date is a date', () => {
    expect(duplicateLookupQuery(fields({ supplier_invoice_number: 'F-1', invoice_date: '2026-11-05', total: 2185 }))).toBe(
      'supplier_id=supplier-1&number=F-1',
    )
    expect(duplicateLookupQuery(fields({ payment_reference: '12345678', invoice_date: '2026-11', total: 2185 }))).toBe(
      'supplier_id=supplier-1&reference=12345678',
    )
    expect(duplicateLookupQuery(fields({ payment_reference: '12345678', invoice_date: '2026-11-05', total: null }))).toBe(
      'supplier_id=supplier-1&reference=12345678',
    )
  })

  it.each(['owner', 'employee'] as const)('asks only the number when the %s paid: an utlägg has no reference to pay with', (payer) => {
    expect(duplicateLookupQuery(fields({ supplier_invoice_number: 'F-1', payment_reference: '12345678', payer }))).toBe(
      'supplier_id=supplier-1&number=F-1',
    )
    expect(duplicateLookupQuery(fields({ payment_reference: '12345678', payer }))).toBeNull()
  })
})

describe('registrationPassesReview', () => {
  it('an aktiebolag reviews before it registers, with or without something to acknowledge', () => {
    expect(registrationPassesReview({ isEF: false, personPaid: false, acknowledges: false })).toBe(true)
    expect(registrationPassesReview({ isEF: false, personPaid: false, acknowledges: true })).toBe(true)
  })

  it('an enskild firma and a person\'s utlägg register without the dialog', () => {
    expect(registrationPassesReview({ isEF: true, personPaid: false, acknowledges: false })).toBe(false)
    expect(registrationPassesReview({ isEF: false, personPaid: true, acknowledges: false })).toBe(false)
    expect(registrationPassesReview({ isEF: true, personPaid: true, acknowledges: false })).toBe(false)
  })

  it('a reused reference to acknowledge sends every registration through the dialog', () => {
    expect(registrationPassesReview({ isEF: true, personPaid: false, acknowledges: true })).toBe(true)
    expect(registrationPassesReview({ isEF: false, personPaid: true, acknowledges: true })).toBe(true)
  })
})

describe('lookupSupplierInvoiceDuplicates: the number', () => {
  it('names the invoice that holds the number and the verifikat it is booked on', async () => {
    const holder = invoiceRow({ supplier_invoice_number: 'F-881', registration_journal_entry_id: 'je-1' })
    const { found } = lookup(
      { supplier_invoices: [holder, invoiceRow()], journal_entries: [voucherRow()] },
      { number: 'F-881' },
    )

    expect(await found).toEqual({
      number: {
        id: holder.id,
        supplier_invoice_number: 'F-881',
        arrival_number: holder.arrival_number,
        invoice_date: '2026-10-01',
        total: 1250,
        currency: 'SEK',
        ore_rounding: null,
        status: 'registered',
        voucher: { journal_entry_id: 'je-1', label: 'A71' },
        payment: { state: 'unpaid' },
      },
      reference: null,
    })
  })

  it('names the payment verifikat when the invoice has no registration verifikat (kontantmetoden)', async () => {
    const holder = invoiceRow({ supplier_invoice_number: 'F-881', status: 'paid', payment_journal_entry_id: 'je-9' })
    const { found } = lookup(
      { supplier_invoices: [holder], journal_entries: [voucherRow({ id: 'je-9', voucher_series: 'b', voucher_number: 12 })] },
      { number: 'F-881' },
    )

    expect((await found).number?.voucher).toEqual({ journal_entry_id: 'je-9', label: 'B12' })
  })

  it('names no verifikat while the invoice is not booked, or its entry has no number yet', async () => {
    const unbooked = lookup({ supplier_invoices: [invoiceRow({ supplier_invoice_number: 'F-881' })] }, { number: 'F-881' })
    expect((await unbooked.found).number?.voucher).toBeNull()
    expect(unbooked.db.tables()).not.toContain('journal_entries')

    const draft = lookup(
      {
        supplier_invoices: [invoiceRow({ supplier_invoice_number: 'F-881', registration_journal_entry_id: 'je-1' })],
        journal_entries: [voucherRow({ voucher_number: null })],
      },
      { number: 'F-881' },
    )
    expect((await draft.found).number?.voucher).toBeNull()
  })

  it('finds nothing for a number only a credited or reversed invoice holds', async () => {
    const { found } = lookup(
      {
        supplier_invoices: [
          invoiceRow({ supplier_invoice_number: 'F-881', status: 'credited' }),
          invoiceRow({ supplier_invoice_number: 'F-881', status: 'reversed' }),
        ],
      },
      { number: 'F-881' },
    )

    expect(await found).toEqual({ number: null, reference: null })
  })
})

describe('lookupSupplierInvoiceDuplicates: the payment reference', () => {
  it('on one other invoice: names it and asks for an acknowledgement', async () => {
    const other = invoiceRow({
      supplier_invoice_number: 'F-700',
      payment_reference: '73005512348',
      invoice_date: '2026-09-14',
      total: 4999.5,
      registration_journal_entry_id: 'je-1',
    })
    const { found } = lookup(
      { supplier_invoices: [other, invoiceRow({ payment_reference: '99887766' })], journal_entries: [voucherRow()] },
      { number: 'F-701', reference: '73005512348' },
    )

    expect(await found).toEqual({
      number: null,
      reference: {
        invoice: {
          id: other.id,
          supplier_invoice_number: 'F-700',
          arrival_number: other.arrival_number,
          invoice_date: '2026-09-14',
          total: 4999.5,
          currency: 'SEK',
          ore_rounding: null,
          status: 'registered',
          voucher: { journal_entry_id: 'je-1', label: 'A71' },
          payment: { state: 'unpaid' },
        },
        count: 1,
        twin: null,
        needs_acknowledgement: true,
      },
    })
  })

  it('compares on the digits: an OCR typed in groups is the same reference', async () => {
    const grouped = invoiceRow({ payment_reference: '7300 5512 348' })
    expect((await lookup({ supplier_invoices: [grouped] }, { reference: '73005512348' }).found).reference?.invoice.id).toBe(grouped.id)

    const plain = invoiceRow({ payment_reference: '73005512348' })
    expect((await lookup({ supplier_invoices: [plain] }, { reference: '7300-5512-348' }).found).reference?.invoice.id).toBe(plain.id)
  })

  it('is not found inside a longer reference', async () => {
    const { found } = lookup(
      {
        supplier_invoices: [
          invoiceRow({ payment_reference: '973005512348' }),
          invoiceRow({ payment_reference: '730055123480' }),
          invoiceRow({ payment_reference: '730055172348' }),
        ],
      },
      { reference: '73005512348' },
    )

    expect((await found).reference).toBeNull()
  })

  it('on two or more invoices it is how the supplier invoices: no acknowledgement, the newest named', async () => {
    const older = invoiceRow({ payment_reference: '5550001', invoice_date: '2026-08-01' })
    const newest = invoiceRow({ payment_reference: '5550001', invoice_date: '2026-10-01' })
    const middle = invoiceRow({ payment_reference: '5550001', invoice_date: '2026-09-01' })
    const { found } = lookup({ supplier_invoices: [older, newest, middle] }, { number: 'F-NEW', reference: '5550001' })

    const reuse = (await found).reference
    expect(reuse).toMatchObject({ count: 3, needs_acknowledgement: false })
    expect(reuse?.invoice.id).toBe(newest.id)
  })

  it('does not count credited or reversed invoices', async () => {
    const live = invoiceRow({ payment_reference: '5550001' })
    const { found } = lookup(
      {
        supplier_invoices: [
          live,
          invoiceRow({ payment_reference: '5550001', status: 'credited' }),
          invoiceRow({ payment_reference: '5550001', status: 'reversed' }),
        ],
      },
      { reference: '5550001' },
    )

    // Two more live ones would make the reuse routine: they are not live.
    expect((await found).reference).toMatchObject({ count: 1, needs_acknowledgement: true, invoice: { id: live.id } })
  })

  it('counts an invoice without a number: it is another invoice', async () => {
    const numberless = invoiceRow({ supplier_invoice_number: null, payment_reference: '5550001' })
    const { found } = lookup({ supplier_invoices: [numberless] }, { number: 'F-NEW', reference: '5550001' })

    expect((await found).reference).toMatchObject({ count: 1, invoice: { id: numberless.id, supplier_invoice_number: null } })
  })

  it('asks the database nothing for a reference without a digit', async () => {
    const { db, found } = lookup({ supplier_invoices: [invoiceRow({ payment_reference: 'enligt avtal' })] }, { reference: 'enligt avtal' })

    expect(await found).toEqual({ number: null, reference: null })
    expect(db.tables()).toEqual([])
  })
})

describe('lookupSupplierInvoiceDuplicates: the number and the reference together', () => {
  it('the invoice that holds the number is the number hit, not a reused reference', async () => {
    const holder = invoiceRow({ supplier_invoice_number: 'F-881', payment_reference: '5550001' })
    const { found } = lookup({ supplier_invoices: [holder] }, { number: 'F-881', reference: '5550001' })

    expect(await found).toMatchObject({ number: { id: holder.id }, reference: null })
  })

  it('answers both when the number is on one invoice and the reference on another', async () => {
    const holder = invoiceRow({ supplier_invoice_number: 'F-881', registration_journal_entry_id: 'je-1' })
    const sharing = invoiceRow({ supplier_invoice_number: 'F-500', payment_reference: '5550001', registration_journal_entry_id: 'je-2' })
    const { found } = lookup(
      {
        supplier_invoices: [holder, sharing],
        journal_entries: [voucherRow(), voucherRow({ id: 'je-2', voucher_number: 40 })],
      },
      { number: 'F-881', reference: '5550001' },
    )

    expect(await found).toMatchObject({
      number: { id: holder.id, voucher: { label: 'A71' } },
      reference: { count: 1, needs_acknowledgement: true, invoice: { id: sharing.id, voucher: { label: 'A40' } } },
    })
  })
})

describe('lookupSupplierInvoiceDuplicates: whose invoices', () => {
  it('never reads another supplier or another company', async () => {
    const { found } = lookup(
      {
        supplier_invoices: [
          invoiceRow({ supplier_invoice_number: 'F-881', payment_reference: '5550001', supplier_id: 'supplier-2' }),
          invoiceRow({ supplier_invoice_number: 'F-881', payment_reference: '5550001', company_id: 'company-2' }),
        ],
      },
      { number: 'F-881', reference: '5550001' },
    )

    expect(await found).toEqual({ number: null, reference: null })
  })

  it('names no verifikat that belongs to another company', async () => {
    const { found } = lookup(
      {
        supplier_invoices: [invoiceRow({ supplier_invoice_number: 'F-881', registration_journal_entry_id: 'je-1' })],
        journal_entries: [voucherRow({ company_id: 'company-2' })],
      },
      { number: 'F-881' },
    )

    expect((await found).number?.voucher).toBeNull()
  })

  it('throws a database error with its code instead of answering "no duplicate"', async () => {
    const db = createSupplierInvoiceRowsDb({})
    db.setTable('supplier_invoices', { error: { message: 'canceling statement due to statement timeout', code: '57014' } })

    await expect(
      lookupSupplierInvoiceDuplicates(db.supabase as unknown as SupabaseClient, 'company-1', {
        supplierId: 'supplier-1',
        number: 'F-881',
      }),
    ).rejects.toMatchObject({ code: '57014' })
  })
})

describe('registeredInvoicePayment', () => {
  const TODAY = '2026-11-25'
  const ORDER = { id: 'po-1', status: 'submitted', created_at: '2026-11-20T08:00:00Z', provider_status: null, provider_error_code: null }
  const facts = (overrides: Record<string, unknown> = {}) => ({
    status: 'registered',
    is_credit_note: false,
    bank_entered_at: null,
    due_date: '2026-12-10',
    remaining_amount: 2185,
    paid_at: null,
    paid_amount: 0,
    open_payment: null,
    ...overrides,
  })

  it('paid: the status says it, with the day it was paid when that is known', () => {
    expect(registeredInvoicePayment(facts({ status: 'paid', paid_at: '2026-10-28T09:12:00Z', remaining_amount: 0 }), TODAY)).toEqual({
      state: 'paid',
      paid_at: '2026-10-28T09:12:00Z',
    })
    expect(registeredInvoicePayment(facts({ status: 'paid', remaining_amount: 0 }), TODAY)).toEqual({ state: 'paid', paid_at: null })
  })

  it('partly paid: how much has been paid', () => {
    expect(registeredInvoicePayment(facts({ status: 'partially_paid', paid_amount: 1000, remaining_amount: 1185 }), TODAY)).toEqual({
      state: 'partially_paid',
      paid_amount: 1000,
    })
  })

  it.each([
    ['a bank payment at the bank', { payment_order: ORDER, batch: null }],
    ['a bank payment waiting for its signature', { payment_order: { ...ORDER, status: 'approved' }, batch: null }],
    ['a payment file', { payment_order: null, batch: { id: 'batch-1', created_at: '2026-11-20T08:00:00Z' } }],
  ])('on its way in %s (the I betalning marker)', (_, open_payment) => {
    expect(registeredInvoicePayment(facts({ open_payment }), TODAY)).toEqual({ state: 'in_payment' })
  })

  it('on its way while the "Inlagd i banken" tick holds, not once the invoice has fallen due unpaid', () => {
    expect(registeredInvoicePayment(facts({ bank_entered_at: '2026-11-20T08:00:00Z' }), TODAY)).toEqual({ state: 'in_payment' })
    expect(registeredInvoicePayment(facts({ bank_entered_at: '2026-11-01T08:00:00Z', due_date: '2026-11-10' }), TODAY)).toEqual({
      state: 'unpaid',
    })
  })

  it('a payment on its way is told before a part payment: what is left is being paid', () => {
    expect(
      registeredInvoicePayment(facts({ status: 'partially_paid', paid_amount: 1000, open_payment: { payment_order: ORDER, batch: null } }), TODAY),
    ).toEqual({ state: 'in_payment' })
  })

  it.each(['registered', 'approved', 'overdue', 'disputed'])('not paid: a live %s invoice that nothing covers', (status) => {
    expect(registeredInvoicePayment(facts({ status }), TODAY)).toEqual({ state: 'unpaid' })
  })
})

describe('lookupSupplierInvoiceDuplicates: where the named invoice\'s payment stands', () => {
  it('a paid invoice: paid, on the day it was, and no payment instruction is read', async () => {
    const holder = invoiceRow({ supplier_invoice_number: 'EX-1042', status: 'paid', paid_at: '2026-10-28T09:12:00Z', paid_amount: 1250, remaining_amount: 0 })
    const { db, found } = lookup({ supplier_invoices: [holder] }, { number: 'EX-1042' })

    expect((await found).number?.payment).toEqual({ state: 'paid', paid_at: '2026-10-28T09:12:00Z' })
    expect(db.tables()).not.toContain('payment_orders')
    expect(db.tables()).not.toContain('supplier_payment_batch_items')
  })

  it('a part-paid invoice: what has been paid', async () => {
    const holder = invoiceRow({ supplier_invoice_number: 'EX-1042', status: 'partially_paid', paid_amount: 500, remaining_amount: 750 })
    const { found } = lookup({ supplier_invoices: [holder] }, { number: 'EX-1042' })

    expect((await found).number?.payment).toEqual({ state: 'partially_paid', paid_amount: 500 })
  })

  it('an invoice an open bank payment or payment file covers: in a payment, read for the invoices the answer names', async () => {
    const ordered = invoiceRow({ supplier_invoice_number: 'EX-1042', status: 'approved' })
    const filed = invoiceRow({ supplier_invoice_number: 'EX-0990', payment_reference: '5550001' })
    const { db, found } = lookup(
      {
        supplier_invoices: [ordered, filed],
        payment_orders: [
          { id: 'po-1', company_id: 'company-1', supplier_invoice_id: ordered.id, status: 'awaiting_signature', created_at: '2026-11-20T08:00:00Z', supplier_invoice_payment_id: null, provider_status: null, provider_error_code: null },
        ],
        supplier_payment_batch_items: [
          { company_id: 'company-1', supplier_invoice_id: filed.id, batch: { id: 'batch-1', status: 'created', created_at: '2026-11-21T08:00:00Z' } },
        ],
      },
      { number: 'EX-1042', reference: '5550001' },
    )

    const answer = await found
    expect(answer.number?.payment).toEqual({ state: 'in_payment' })
    expect(answer.reference?.invoice.payment).toEqual({ state: 'in_payment' })
    expect(db.findCalls('payment_orders', 'in')[0]).toEqual(['supplier_invoice_id', [ordered.id, filed.id]])
  })

  it('a cancelled payment file or a failed bank payment covers nothing: not paid', async () => {
    const holder = invoiceRow({ supplier_invoice_number: 'EX-1042' })
    const { found } = lookup(
      {
        supplier_invoices: [holder],
        payment_orders: [
          { id: 'po-1', company_id: 'company-1', supplier_invoice_id: holder.id, status: 'failed', created_at: '2026-11-20T08:00:00Z', supplier_invoice_payment_id: null, provider_status: null, provider_error_code: null },
        ],
        supplier_payment_batch_items: [
          { company_id: 'company-1', supplier_invoice_id: holder.id, batch: { id: 'batch-1', status: 'cancelled', created_at: '2026-11-21T08:00:00Z' } },
        ],
      },
      { number: 'EX-1042' },
    )

    expect((await found).number?.payment).toEqual({ state: 'unpaid' })
  })
})

describe('lookupSupplierInvoiceDuplicates: the same document again (a twin)', () => {
  // A supplier with one OCR on every invoice and no invoice numbers, as an insurer's Betalningsunderlag.
  const period = (invoice_date: string, overrides: Row = {}) =>
    invoiceRow({ supplier_invoice_number: null, payment_reference: '5550001', invoice_date, total: 2185, ...overrides })

  it('among three invoices on the reference, the one with the same date and amount asks, and is named', async () => {
    const september = period('2026-09-05')
    const october = period('2026-10-05', { status: 'paid', paid_at: '2026-10-28T09:12:00Z', paid_amount: 2185, remaining_amount: 0, registration_journal_entry_id: 'je-1' })
    const november = period('2026-11-05')
    const { found } = lookup(
      { supplier_invoices: [september, october, november], journal_entries: [voucherRow({ voucher_number: 64 })] },
      { reference: '5550001', invoiceDate: '2026-10-05', total: 2185, currency: 'SEK' },
    )

    const reuse = (await found).reference
    expect(reuse).toMatchObject({ count: 3, needs_acknowledgement: true, invoice: { id: november.id } })
    expect(reuse?.twin).toMatchObject({
      id: october.id,
      supplier_invoice_number: null,
      arrival_number: october.arrival_number,
      voucher: { label: 'A64' },
      payment: { state: 'paid', paid_at: '2026-10-28T09:12:00Z' },
    })
  })

  it('the next period\'s invoice on the reference is not asked about: another date', async () => {
    const { found } = lookup(
      { supplier_invoices: [period('2026-09-05'), period('2026-10-05'), period('2026-11-05')] },
      { reference: '5550001', invoiceDate: '2026-12-05', total: 2185 },
    )

    expect((await found).reference).toMatchObject({ count: 3, twin: null, needs_acknowledgement: false })
  })

  it('the same date with another amount, or another currency, is not a twin', async () => {
    const rows = [period('2026-09-05'), period('2026-10-05'), period('2026-11-05', { currency: 'EUR' })]
    const otherAmount = lookup({ supplier_invoices: rows }, { reference: '5550001', invoiceDate: '2026-10-05', total: 2185.01 })
    expect((await otherAmount.found).reference).toMatchObject({ twin: null, needs_acknowledgement: false })

    const otherCurrency = lookup({ supplier_invoices: rows }, { reference: '5550001', invoiceDate: '2026-11-05', total: 2185, currency: 'SEK' })
    expect((await otherCurrency.found).reference).toMatchObject({ twin: null, needs_acknowledgement: false })

    const sameCurrency = lookup({ supplier_invoices: rows }, { reference: '5550001', invoiceDate: '2026-11-05', total: 2185, currency: 'eur' })
    expect((await sameCurrency.found).reference?.twin?.id).toBe(rows[2].id)
  })

  it('compares the amount the list shows: öresavrundning applied', async () => {
    const rounded = period('2026-10-05', { total: 2184.6, ore_rounding: true })
    const twin = lookup({ supplier_invoices: [period('2026-09-05'), rounded] }, { reference: '5550001', invoiceDate: '2026-10-05', total: 2185 })
    expect((await twin.found).reference?.twin?.id).toBe(rounded.id)

    const exact = lookup({ supplier_invoices: [period('2026-09-05'), rounded] }, { reference: '5550001', invoiceDate: '2026-10-05', total: 2184.6 })
    expect((await exact.found).reference?.twin).toBeNull()
  })

  it('credited and reversed invoices are no twin', async () => {
    const { found } = lookup(
      {
        supplier_invoices: [
          period('2026-09-05'),
          period('2026-11-05'),
          period('2026-10-05', { status: 'credited' }),
          period('2026-10-05', { status: 'reversed' }),
        ],
      },
      { reference: '5550001', invoiceDate: '2026-10-05', total: 2185 },
    )

    expect((await found).reference).toMatchObject({ count: 2, twin: null, needs_acknowledgement: false })
  })

  it('on the only other invoice the twin is named instead of the reuse', async () => {
    const only = period('2026-10-05')
    const { found } = lookup({ supplier_invoices: [only] }, { reference: '5550001', invoiceDate: '2026-10-05', total: 2185 })

    expect((await found).reference).toMatchObject({ count: 1, needs_acknowledgement: true, twin: { id: only.id }, invoice: { id: only.id } })
  })

  it('finds a twin older than the newest candidates the reference read returns, on its own date', async () => {
    // A supplier that has invoiced on the reference every day: 200 newer invoices fill the read.
    const newer = Array.from({ length: 200 }, (_, i) =>
      period(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), { total: 999 }),
    )
    const older = period('2025-06-05', { status: 'paid', paid_at: '2025-06-20T10:00:00Z', remaining_amount: 0 })
    const { db, found } = lookup({ supplier_invoices: [...newer, older] }, { reference: '5550001', invoiceDate: '2025-06-05', total: 2185 })

    expect((await found).reference).toMatchObject({ count: 200, needs_acknowledgement: true, twin: { id: older.id, payment: { state: 'paid' } } })
    expect(db.findCalls('supplier_invoices', 'eq')).toContainEqual(['invoice_date', '2025-06-05'])
  })

  it('asks no second read while the reference read holds every candidate', async () => {
    const { db, found } = lookup(
      { supplier_invoices: [period('2026-09-05'), period('2026-10-05')] },
      { reference: '5550001', invoiceDate: '2026-12-05', total: 2185 },
    )

    expect((await found).reference?.twin).toBeNull()
    expect(db.findCalls('supplier_invoices', 'eq').filter(([column]) => column === 'invoice_date')).toEqual([])
  })

  it('looks for no twin without both the date and the amount', async () => {
    const rows = [period('2026-09-05'), period('2026-10-05')]
    expect((await lookup({ supplier_invoices: rows }, { reference: '5550001', invoiceDate: '2026-10-05' }).found).reference?.twin).toBeNull()
    expect((await lookup({ supplier_invoices: rows }, { reference: '5550001', total: 2185 }).found).reference?.twin).toBeNull()
  })
})

describe('readDuplicateNumberHolder: what the 409 names', () => {
  function read(tables: { supplier_invoices: Row[]; journal_entries?: Row[] }, number: string | null = 'EX-1042') {
    const db = createSupplierInvoiceRowsDb({ journal_entries: [], ...tables })
    return readDuplicateNumberHolder(db.supabase as unknown as SupabaseClient, 'company-1', 'supplier-1', number)
  }

  it('the invoice with the number: whether it is paid, what is left, and the verifikat it is on', async () => {
    const holder = invoiceRow({
      supplier_invoice_number: 'EX-1042',
      status: 'paid',
      paid_at: '2026-10-28T09:12:00Z',
      remaining_amount: 0,
      registration_journal_entry_id: 'je-1',
    })

    expect(await read({ supplier_invoices: [holder], journal_entries: [voucherRow()] })).toEqual({
      id: holder.id,
      supplier_invoice_number: 'EX-1042',
      status: 'paid',
      credit_note_id: null,
      paid_at: '2026-10-28T09:12:00Z',
      remaining_amount: 0,
      voucher: { journal_entry_id: 'je-1', label: 'A71' },
    })
  })

  it('names the live re-issue when a credited original carries the number too', async () => {
    const original = invoiceRow({ supplier_invoice_number: 'EX-1042', status: 'credited' })
    const reissue = invoiceRow({ supplier_invoice_number: 'EX-1042', status: 'approved', remaining_amount: 1250 })

    expect(await read({ supplier_invoices: [original, reissue] })).toMatchObject({
      id: reissue.id,
      status: 'approved',
      credit_note_id: null,
      paid_at: null,
      remaining_amount: 1250,
    })
  })

  it('a credited one alone names its credit note, so the editor can offer to undo the crediting', async () => {
    const holder = invoiceRow({ supplier_invoice_number: 'EX-1042', status: 'credited' })
    const creditNote = invoiceRow({ supplier_invoice_number: 'KR-1', is_credit_note: true, credited_invoice_id: holder.id })

    expect(await read({ supplier_invoices: [holder, creditNote] })).toMatchObject({ id: holder.id, credit_note_id: creditNote.id, voucher: null })
  })

  it('nothing without a number, or once the row is gone', async () => {
    expect(await read({ supplier_invoices: [invoiceRow({ supplier_invoice_number: 'EX-1042' })] }, null)).toBeNull()
    expect(await read({ supplier_invoices: [] })).toBeNull()
  })
})
