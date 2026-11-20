import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  duplicateLookupQuery,
  lookupSupplierInvoiceDuplicates,
  referenceReuseNeedsAcknowledgement,
  registrationPassesReview,
  type DuplicateLookupFields,
} from '../duplicate-lookup'
import { createSupplierInvoiceRowsDb, invoiceRow, voucherRow } from './supplier-invoice-rows-db'

type Row = Record<string, unknown>

function lookup(
  tables: { supplier_invoices: Row[]; journal_entries?: Row[] },
  input: { number?: string; reference?: string },
) {
  const db = createSupplierInvoiceRowsDb({ journal_entries: [], ...tables })
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
        },
        count: 1,
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
