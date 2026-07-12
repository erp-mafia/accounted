import type { BookingTemplateCategory, JournalEntrySourceType } from '@/types'

/**
 * Map a booking-template category to the journal `source_type` an entry booked
 * from that template should carry, when the category has a dedicated source
 * type.
 *
 * VAT-category templates (the system "Momsredovisning (nettning)" template and
 * any user template filed under `vat`) book as `vat_settlement` so the entry
 * lands in the company's configured VAT voucher series
 * (`default_voucher_series_per_source_type.vat_settlement`) instead of the
 * shared `manual` series, keeping momsredovisning verifikat separate from
 * "övriga".
 *
 * Returns `undefined` for categories with no dedicated source type: the entry
 * keeps whatever source type the form was already using.
 */
export function sourceTypeForTemplateCategory(
  category: BookingTemplateCategory | null | undefined,
): JournalEntrySourceType | undefined {
  return category === 'vat' ? 'vat_settlement' : undefined
}
