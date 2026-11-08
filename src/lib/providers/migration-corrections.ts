import { z } from 'zod'
import type { SupplierInvoiceDto } from './dto'

export const MigrationInvoiceCorrectionSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(100),
}).strict()

export type MigrationInvoiceCorrection = z.infer<typeof MigrationInvoiceCorrectionSchema>

/** Use the provider's invoice number first, then OCR, then a dash for unknown. */
export function resolveMigrationSupplierInvoiceNumber(invoice: Pick<SupplierInvoiceDto, 'invoiceNumber' | 'ocrNumber'>): string {
  return invoice.invoiceNumber?.trim() || invoice.ocrNumber?.trim() || '-'
}

/** Only fill a missing number; never replace an upstream identity. */
export function applyMigrationInvoiceCorrection(invoice: SupplierInvoiceDto, correction?: unknown): SupplierInvoiceDto {
  const original = invoice.invoiceNumber?.trim()
  const number = original || (correction ? MigrationInvoiceCorrectionSchema.parse(correction).invoiceNumber
    : resolveMigrationSupplierInvoiceNumber(invoice))
  return number && number !== invoice.invoiceNumber ? { ...invoice, invoiceNumber: number } : invoice
}
