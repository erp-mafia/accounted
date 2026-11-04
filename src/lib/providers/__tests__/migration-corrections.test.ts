import { expect, it } from 'vitest'
import { applyMigrationInvoiceCorrection } from '../migration-corrections'
import type { SupplierInvoiceDto } from '../dto'
it('fills a missing number without modifying the source DTO', () => {
  const dto = { invoiceNumber: '' } as SupplierInvoiceDto
  expect(applyMigrationInvoiceCorrection(dto, { invoiceNumber: ' INV-7 ' }).invoiceNumber).toBe('INV-7')
  expect(dto.invoiceNumber).toBe('')
})
it('never replaces a number from the source', () => {
  const dto = { invoiceNumber: 'source' } as SupplierInvoiceDto
  expect(applyMigrationInvoiceCorrection(dto, { invoiceNumber: 'replacement' })).toBe(dto)
})
it('rejects empty or additional fields', () => {
  const dto = { invoiceNumber: '' } as SupplierInvoiceDto
  expect(() => applyMigrationInvoiceCorrection(dto, { invoiceNumber: ' ' })).toThrow()
  expect(() => applyMigrationInvoiceCorrection(dto, { invoiceNumber: 'A', total: 1 })).toThrow()
})


it('uses OCR without requiring a manual correction and keeps leading zeros', () => {
  const dto = { invoiceNumber: ' ', ocrNumber: ' 001234 ' } as SupplierInvoiceDto
  expect(applyMigrationInvoiceCorrection(dto).invoiceNumber).toBe('001234')
  expect(dto.invoiceNumber).toBe(' ')
})
it('retains an explicit saved correction before using an OCR fallback', () => {
  const dto = { invoiceNumber: '', ocrNumber: '001234' } as SupplierInvoiceDto
  expect(applyMigrationInvoiceCorrection(dto, { invoiceNumber: 'MANUAL-1' }).invoiceNumber).toBe('MANUAL-1')
})


it('uses a dash when neither source number nor OCR is available', () => {
  const source = { invoiceNumber: ' ', ocrNumber: ' ' } as SupplierInvoiceDto
  expect(applyMigrationInvoiceCorrection(source).invoiceNumber).toBe('-')
  expect(source.invoiceNumber).toBe(' ')
})
