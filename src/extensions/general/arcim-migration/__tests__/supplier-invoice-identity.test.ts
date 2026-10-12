import { describe, expect, it } from 'vitest'
import {
  existingInvoiceKey, existingInvoiceKeys, fortnoxNumberOf, listedInvoiceKeys, listedMatchNumber, storedMatchNumber,
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
   * holds the löpnummer as its supplier number.
   */
  describe('Fortnox löpnummer', () => {
    const fortnoxRecord = listed({ id: '367', invoiceNumber: '21879926' })

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

    it('still knows a hand-entered copy by the supplier and the supplier number', () => {
      const keys = existingInvoiceKeys({ supplier_id: SUPPLIER, supplier_invoice_number: '21879926', invoice_date: '2026-09-30', total: 608 })
      expect(listedInvoiceKeys(SUPPLIER, fortnoxRecord, 'fortnox').some(key => keys.includes(key))).toBe(true)
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
})
