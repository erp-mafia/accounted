import { z } from 'zod'
import type { SupplierInvoiceDto } from './dto'

export const MigrationInvoiceCorrectionSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(100),
}).strict()

export type MigrationInvoiceCorrection = z.infer<typeof MigrationInvoiceCorrectionSchema>

/** Only fill a missing number; never replace an upstream identity. */
export function applyMigrationInvoiceCorrection(invoice: SupplierInvoiceDto, correction?: unknown): SupplierInvoiceDto {
  if (!correction || invoice.invoiceNumber?.trim()) return invoice
  const parsed = MigrationInvoiceCorrectionSchema.parse(correction)
  return { ...invoice, invoiceNumber: parsed.invoiceNumber }
}
