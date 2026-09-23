import { describe, expect, it } from 'vitest'
import { matchBokioSupplierInvoices, type BokioSupplierRow } from '../lib/complete-bokio-supplier-invoices'
import { mapBokioToSupplierInvoice } from '@/lib/providers/bokio/mapper'

const source = (id = 'source', supplier = 'supplier-source', name = 'Supplier') => mapBokioToSupplierInvoice({
  id, invoiceNumber: '1001', invoiceDate: '2026-01-02', currency: 'SEK', totalAmount: 1250,
  remainingAmount: 0, supplierRef: { id: supplier, name },
})
const local = (id = 'local', supplier = 'supplier') => ({
  id, supplier_id: supplier, supplier_invoice_number: '1001', invoice_date: '2026-01-02',
  currency: 'SEK', total: 1250, is_credit_note: false,
}) as BokioSupplierRow
const suppliers = [{ id: 'supplier', name: 'Supplier' }]

describe('Bokio historical supplier identity', () => {
  it('requires supplier, number, date, currency, amount and credit identity', () => {
    expect(matchBokioSupplierInvoices([local()], [source()], suppliers, []).size).toBe(1)
    for (const change of [{ total: 1250.01 }, { currency: 'EUR' }, { is_credit_note: true },
      { invoice_date: '2026-01-03' }, { supplier_id: 'other' }, { supplier_invoice_number: '1002' }]) {
      expect(matchBokioSupplierInvoices([{ ...local(), ...change }], [source()], suppliers, []).size).toBe(0)
    }
  })
  it('does not collapse equal invoice numbers from different suppliers', () => {
    const rows = [local(), local('second', 'supplier-2')]
    const allSuppliers = [...suppliers, { id: 'supplier-2', name: 'Second supplier' }]
    const result = matchBokioSupplierInvoices(rows, [source(), source('second-source', 'party-2', 'Second supplier')], allSuppliers, [])
    expect(result.get('local')?.id).toBe('source')
    expect(result.get('second')?.id).toBe('second-source')
  })
  it('checks ambiguity across the full population and refuses conflicting durable identities', () => {
    expect(matchBokioSupplierInvoices([local(), local('complete')], [source()], suppliers, []).size).toBe(0)
    expect(matchBokioSupplierInvoices([local()], [source(), source('another')], suppliers, []).size).toBe(0)
    expect(matchBokioSupplierInvoices([local()], [source()], suppliers, [
      { resource: 'supplierInvoices', source_id: 'source', target_id: 'local' },
      { resource: 'supplierInvoices', source_id: 'another', target_id: 'local' },
    ]).size).toBe(0)
  })
  it('prefers source party IDs and invoice IDs over names but still verifies immutable facts', () => {
    const mappings = [{ resource: 'suppliers', source_id: 'supplier-source', target_id: 'supplier' },
      { resource: 'supplierInvoices', source_id: 'source', target_id: 'local' }]
    expect(matchBokioSupplierInvoices([local()], [source('source', 'supplier-source', 'Renamed')], suppliers, mappings).size).toBe(1)
    expect(matchBokioSupplierInvoices([{ ...local(), total: 1251 }], [source()], suppliers, mappings).size).toBe(0)
  })
  it('uses a durable identity for number-less invoices and still checks the amount', () => {
    const dto = { ...source(), invoiceNumber: '' }
    const mappings = [{ resource: 'supplierInvoices', source_id: 'source', target_id: 'local' }]
    expect(matchBokioSupplierInvoices([{ ...local(), supplier_invoice_number: '' }], [dto], suppliers, mappings).size).toBe(1)
    expect(matchBokioSupplierInvoices([{ ...local(), supplier_invoice_number: '', total: 1251 }], [dto], suppliers, mappings).size).toBe(0)
    expect(matchBokioSupplierInvoices([{ ...local(), supplier_invoice_number: '' }], [dto], suppliers, []).size).toBe(0)
  })
  it('refuses a same-name fallback when either supplier population is ambiguous', () => {
    expect(matchBokioSupplierInvoices([local()], [source()], [...suppliers, { id: 'other', name: 'Supplier' }], []).size).toBe(0)
    expect(matchBokioSupplierInvoices([local()], [source(), source('other-invoice', 'other-party')], suppliers, []).size).toBe(0)
  })
})
