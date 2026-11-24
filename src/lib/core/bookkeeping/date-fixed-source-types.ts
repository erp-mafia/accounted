/**
 * Entry types whose date carries structural meaning: an opening balance is
 * its year's first day, a year-end verifikat its year's last, a VAT
 * settlement its momsperiod's. Neither the verifikat nor its storno moves off
 * that date: an inline rättelse refuses them a new date (the same list as the
 * correct_entry_metadata RPC), and a storno of one is never dated in a later
 * open period (storno-target.ts).
 */
export const DATE_FIXED_SOURCE_TYPES: readonly string[] = ['opening_balance', 'year_end', 'vat_settlement']
