import { z } from 'zod'
import { PACK_CATEGORIES, PACK_ENTITY_TYPES } from '@/lib/packs/schema'

/**
 * Request-body schemas shared by the booking-template routes
 * (/api/settings/booking-templates, its [id] and import siblings).
 *
 * The category / entity_type enums mirror `booking_template_library`'s CHECK
 * constraints via the pack contract. The line schema is deliberately looser
 * than `PackLineSchema`: user templates may carry both `ratio` and `vat_rate`
 * on a line, which the pack validator rejects.
 */
export const BookingTemplateLineSchema = z.object({
  account: z.string().regex(/^\d{4}$/),
  label: z.string().min(1),
  side: z.enum(['debit', 'credit']),
  type: z.enum(['business', 'vat', 'settlement']),
  ratio: z.number().min(0).max(10).optional(),
  vat_rate: z.number().min(0).max(1).optional(),
})

export const BookingTemplateCategorySchema = z.enum(PACK_CATEGORIES)

export const BookingTemplateEntityTypeSchema = z.enum(PACK_ENTITY_TYPES)
