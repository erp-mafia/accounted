import { z } from 'zod'
import { CreateInvoiceItemSchema } from '@/lib/api/schemas'
import { DimensionsBagSchema } from '@/lib/bookkeeping/dimension-resolver'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

/**
 * Staged update_invoice params: { invoice_id, changes }.
 *
 * Deliberately excludes customer_id, currency, document_type, invoice_number,
 * and status: those are structural or server-controlled, and a draft that
 * needs a different customer or currency is recreated instead. `items` is a
 * FULL REPLACE: when present, every existing invoice_items row is deleted and
 * the array becomes the new line set. The item shape reuses the web API's
 * CreateInvoiceItemSchema so accrual, ROT/RUT, and posting-account rules
 * cannot drift between the surfaces.
 */
const InvoiceChangesSchema = z
  .object({
    notes: z.string().optional(),
    invoice_date: isoDate.optional(),
    due_date: isoDate.optional(),
    delivery_date: isoDate.nullable().optional(),
    your_reference: z.string().optional(),
    our_reference: z.string().optional(),
    // Fakturamärkning: buyer-required marking, separate from your_reference.
    invoice_marking: z.string().max(200).optional(),
    items: z.array(CreateInvoiceItemSchema).min(1, 'At least one item is required').optional(),
    // Replaces the whole bag; {} clears all tags.
    default_dimensions: DimensionsBagSchema.optional(),
  })
  .strict()
  .superRefine((changes, ctx) => {
    if (Object.keys(changes).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one invoice field must be supplied',
      })
    }
  })

export const UpdateInvoiceParamsSchema = z
  .object({
    invoice_id: z.string().uuid(),
    changes: InvoiceChangesSchema,
  })
  .strict()

