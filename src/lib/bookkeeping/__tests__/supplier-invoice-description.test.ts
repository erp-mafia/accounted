import { describe, expect, it } from 'vitest'
import {
  buildSupplierDescription,
  supplierInvoiceReference,
} from '@/lib/bookkeeping/supplier-invoice-description'

describe('buildSupplierDescription', () => {
  it('prints a numbered invoice exactly as before', () => {
    expect(buildSupplierDescription('Leverantörsfaktura', 'LF-1', 'Leverantör AB', '(ankomstnr 3)'))
      .toBe('Leverantörsfaktura LF-1, Leverantör AB (ankomstnr 3)')
    expect(buildSupplierDescription('Leverantörsfaktura', 'LF-1')).toBe('Leverantörsfaktura LF-1')
  })

  it('keeps a stored number byte for byte, surrounding whitespace included', () => {
    expect(buildSupplierDescription('Leverantörsfaktura', ' 4711', 'Leverantör AB'))
      .toBe('Leverantörsfaktura  4711, Leverantör AB')
  })

  it('leaves a missing number out instead of printing a placeholder (crm#1039)', () => {
    for (const missing of [null, undefined, '', '   ']) {
      expect(buildSupplierDescription('Leverantörsfaktura', missing, 'Leverantör AB', '(ankomstnr 3)'))
        .toBe('Leverantörsfaktura, Leverantör AB (ankomstnr 3)')
      expect(buildSupplierDescription('Leverantörsfaktura', missing)).toBe('Leverantörsfaktura')
    }
  })
})

describe('supplierInvoiceReference', () => {
  it('is the supplier number when there is one', () => {
    expect(supplierInvoiceReference('LF-1', 3)).toBe('LF-1')
  })

  it('names a number-less invoice by its ankomstnummer', () => {
    expect(supplierInvoiceReference(null, 3)).toBe('ankomstnr 3')
    expect(supplierInvoiceReference('  ', 3)).toBe('ankomstnr 3')
  })

  it('is empty only when neither is known', () => {
    expect(supplierInvoiceReference(null, null)).toBe('')
    expect(supplierInvoiceReference(undefined, undefined)).toBe('')
  })
})
