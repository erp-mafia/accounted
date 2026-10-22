import { describe, expect, it } from 'vitest'
import {
  existingInvoiceKey, existingInvoiceKeys, fortnoxNumberOf, listedInvoiceKeys, listedMatchNumber, storedMatchNumber,
  supplierNumberLedger,
} from '../lib/supplier-invoice-identity'

const SUPPLIER = 'b9c1d2e3-0000-4000-8000-000000000001'
const listed = (over: Partial<{ id: string; invoiceNumber: string; issueDate: string; value: number }> = {}) => ({
  id: over.id ?? 'fe0e8b66-7adf-4f20-bd2d-6117df31c810',
  invoiceNumber: over.invoiceNumber ?? '',
  issueDate: over.issueDate ?? '2026-03-27',
  legalMonetaryTotal: { payableAmount: { value: over.value ?? 150 } },
})

describe('supplier invoice identity', () => {
  it('knows a numbered invoice by supplier and number only', () => {
    const key = existingInvoiceKey({ supplier_id: SUPPLIER, supplier_invoice_number: 'F-1', invoice_date: '2026-01-01', total: 10 })
    expect(listedInvoiceKeys(SUPPLIER, listed({ invoiceNumber: 'F-1', value: 99 }))).toEqual([key])
  })

  it('recognises a stored number-less invoice by supplier, date and amount, so a re-run adds no duplicate', () => {
    const key = existingInvoiceKey({ supplier_id: SUPPLIER, supplier_invoice_number: null, invoice_date: '2026-03-27', total: '150.00' })
    expect(listedInvoiceKeys(SUPPLIER, listed())).toContain(key)
  })

  it('tells number-less invoices apart when the date or the amount differs', () => {
    const key = existingInvoiceKey({ supplier_id: SUPPLIER, supplier_invoice_number: null, invoice_date: '2026-03-27', total: 150 })
    expect(listedInvoiceKeys(SUPPLIER, listed({ value: 150.01 }))).not.toContain(key)
    expect(listedInvoiceKeys(SUPPLIER, listed({ issueDate: '2026-03-28' }))).not.toContain(key)
  })

  it('matches a credit note stored as a magnitude against a negative provider amount', () => {
    const key = existingInvoiceKey({ supplier_id: SUPPLIER, supplier_invoice_number: null, invoice_date: '2026-03-27', total: 150 })
    expect(listedInvoiceKeys(SUPPLIER, listed({ value: -150 }))).toContain(key)
  })

  it('still recognises a row an earlier import stored with the provider record id as its number', () => {
    const legacy = existingInvoiceKey({
      supplier_id: SUPPLIER, supplier_invoice_number: 'fe0e8b66-7adf-4f20-bd2d-6117df31c810', invoice_date: '2026-03-27', total: 150,
    })
    expect(listedInvoiceKeys(SUPPLIER, listed())).toContain(legacy)
  })

  it('treats a whitespace-only provider number as none, the way the mapper stores it (NULL)', () => {
    const key = existingInvoiceKey({ supplier_id: SUPPLIER, supplier_invoice_number: null, invoice_date: '2026-03-27', total: 150 })
    expect(listedInvoiceKeys(SUPPLIER, listed({ invoiceNumber: '   ' }))).toContain(key)
  })

  it('gives a row without a supplier no key', () => {
    expect(existingInvoiceKey({ supplier_id: null, supplier_invoice_number: 'F-1', invoice_date: null, total: null })).toBeNull()
  })

  /**
   * crm#1157: Fortnox numbers its supplier invoices itself (löpnummer, the
   * record id its mapper hands on). A Fortnox record is known by it, whatever
   * the supplier's number says, and an import from before fortnox_number
   * holds the löpnummer as its supplier number. The supplier's number alone
   * never identifies a Fortnox record: suppliers reuse one (crm#1039).
   */
  describe('Fortnox löpnummer', () => {
    const fortnoxRecord = listed({ id: '367', invoiceNumber: '21879926', issueDate: '2026-09-30', value: 608 })

    it('knows a stored Fortnox invoice by its löpnummer whatever its supplier number', () => {
      const keys = existingInvoiceKeys({
        supplier_id: SUPPLIER, supplier_invoice_number: 'typed by hand', invoice_date: '2026-01-01', total: 1, fortnox_number: '367',
      })
      expect(listedInvoiceKeys(SUPPLIER, fortnoxRecord, 'fortnox').some(key => keys.includes(key))).toBe(true)
      expect(listedInvoiceKeys('another-supplier', fortnoxRecord, 'fortnox').some(key => keys.includes(key))).toBe(true)
    })

    it('knows an import from before the column by the löpnummer in its supplier number, on the same supplier', () => {
      const keys = existingInvoiceKeys({ supplier_id: SUPPLIER, supplier_invoice_number: '367', invoice_date: '2026-09-25', total: 608 })
      expect(listedInvoiceKeys(SUPPLIER, fortnoxRecord, 'fortnox').some(key => keys.includes(key))).toBe(true)
      expect(listedInvoiceKeys('another-supplier', fortnoxRecord, 'fortnox').some(key => keys.includes(key))).toBe(false)
    })

    it('never takes another Fortnox import for that earlier import, even where its supplier number is the löpnummer', () => {
      const keys = existingInvoiceKeys({
        supplier_id: SUPPLIER, supplier_invoice_number: '367', invoice_date: '2026-09-25', total: 608, fortnox_number: '12',
      })
      expect(listedInvoiceKeys(SUPPLIER, fortnoxRecord, 'fortnox').some(key => keys.includes(key))).toBe(false)
    })

    it('knows a hand-entered copy by the supplier, the supplier number, the date and the amount', () => {
      const keys = existingInvoiceKeys({ supplier_id: SUPPLIER, supplier_invoice_number: '21879926', invoice_date: '2026-09-30', total: '608.00' })
      expect(listedInvoiceKeys(SUPPLIER, fortnoxRecord, 'fortnox').some(key => keys.includes(key))).toBe(true)
    })

    it('never takes an invoice with the same supplier number on another date or amount: suppliers reuse numbers', () => {
      for (const other of [{ invoice_date: '2026-10-30', total: 608 }, { invoice_date: '2026-09-30', total: 609 }]) {
        const keys = existingInvoiceKeys({ supplier_id: SUPPLIER, supplier_invoice_number: '21879926', ...other })
        expect(listedInvoiceKeys(SUPPLIER, fortnoxRecord, 'fortnox').some(key => keys.includes(key))).toBe(false)
      }
    })

    it('never takes another Fortnox import by the supplier number, even on the same date and amount', () => {
      const keys = existingInvoiceKeys({
        supplier_id: SUPPLIER, supplier_invoice_number: '21879926', invoice_date: '2026-09-30', total: 608, fortnox_number: '366',
      })
      expect(listedInvoiceKeys(SUPPLIER, fortnoxRecord, 'fortnox').some(key => keys.includes(key))).toBe(false)
    })

    it('knows a hand-entered number-less copy by supplier, date and amount', () => {
      const numberless = listed({ id: '370', invoiceNumber: '', issueDate: '2026-09-30', value: 608 })
      const keys = existingInvoiceKeys({ supplier_id: SUPPLIER, supplier_invoice_number: null, invoice_date: '2026-09-30', total: 608 })
      expect(listedInvoiceKeys(SUPPLIER, numberless, 'fortnox').some(key => keys.includes(key))).toBe(true)
      const stamped = existingInvoiceKeys({
        supplier_id: SUPPLIER, supplier_invoice_number: null, invoice_date: '2026-09-30', total: 608, fortnox_number: '371',
      })
      expect(listedInvoiceKeys(SUPPLIER, numberless, 'fortnox').some(key => stamped.includes(key))).toBe(false)
    })

    it('never takes another provider\'s record id for a löpnummer', () => {
      expect(fortnoxNumberOf('visma', { id: '367' })).toBeNull()
      expect(listedInvoiceKeys(SUPPLIER, fortnoxRecord, 'visma')).toEqual([`${SUPPLIER}::21879926`])
      const keys = existingInvoiceKeys({ supplier_id: SUPPLIER, supplier_invoice_number: '367', invoice_date: '2026-09-25', total: 608 })
      expect(listedInvoiceKeys(SUPPLIER, fortnoxRecord, 'visma').some(key => keys.includes(key))).toBe(false)
    })

    it('matches a Fortnox record on its löpnummer and any other on the supplier number', () => {
      expect(listedMatchNumber('fortnox', { id: '367', invoiceNumber: '21879926' })).toBe('367')
      expect(listedMatchNumber('visma', { id: 'guid-1', invoiceNumber: '21879926' })).toBe('21879926')
      expect(storedMatchNumber('fortnox', { supplier_invoice_number: '21879926', fortnox_number: '367' })).toBe('367')
      expect(storedMatchNumber('fortnox', { supplier_invoice_number: '367', fortnox_number: null })).toBe('367')
      expect(storedMatchNumber('visma', { supplier_invoice_number: '21879926', fortnox_number: '367' })).toBe('21879926')
    })
  })

  /**
   * crm#1039 in the /migrate import of Fortnox supplier invoices: the rule
   * commit_provider_migration_records applies to the background import.
   */
  describe('reused supplier numbers', () => {
    const held = { supplier_id: SUPPLIER, supplier_invoice_number: 'AVT-1', invoice_date: '2026-09-01', status: 'registered' }
    const next = (over: Record<string, unknown> = {}) => ({
      supplier_id: SUPPLIER, supplier_invoice_number: 'AVT-1', invoice_date: '2026-10-01', status: 'registered',
      payment_reference: null, ...over,
    })

    it('keeps a number no live invoice of the supplier holds', () => {
      const ledger = supplierNumberLedger([held])
      expect(ledger.plan(next({ supplier_invoice_number: 'AVT-2' }))).toBe('keep')
      expect(ledger.plan(next({ supplier_id: 'another-supplier' }))).toBe('keep')
      expect(ledger.plan(next({ supplier_invoice_number: null }))).toBe('keep')
      expect(supplierNumberLedger([{ ...held, status: 'credited' }]).plan(next())).toBe('keep')
      expect(ledger.plan(next({ status: 'reversed' }))).toBe('keep')
    })

    it('stores the same number on another date as the payment reference', () => {
      expect(supplierNumberLedger([held]).plan(next())).toBe('asPaymentReference')
      expect(supplierNumberLedger([held]).plan(next({ payment_reference: 'AVT-1' }))).toBe('asPaymentReference')
    })

    it('refuses the same number on the same date, also against an invoice stored that way', () => {
      const ledger = supplierNumberLedger([held])
      expect(ledger.plan(next({ invoice_date: '2026-09-01' }))).toBe('numberTaken')
      ledger.record(next({ supplier_invoice_number: null, payment_reference: 'AVT-1' }))
      expect(ledger.plan(next())).toBe('numberTaken')
      expect(ledger.plan(next({ invoice_date: '2026-11-01' }))).toBe('asPaymentReference')
    })

    it('refuses a record that already carries another payment reference: both cannot be stored', () => {
      expect(supplierNumberLedger([held]).plan(next({ payment_reference: '4455667788' }))).toBe('numberTaken')
    })

    it('counts what this run stores, not only what the database held', () => {
      const ledger = supplierNumberLedger([])
      const first = next()
      expect(ledger.plan(first)).toBe('keep')
      ledger.record(first)
      expect(ledger.plan(next({ invoice_date: '2026-12-01' }))).toBe('asPaymentReference')
    })
  })
})
