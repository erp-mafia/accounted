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
