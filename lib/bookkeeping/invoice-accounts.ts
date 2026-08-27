/**
 * Pure invoice booking constants and account resolvers.
 *
 * Split from invoice-entries.ts (whose generators import the bookkeeping
 * engine, and through it the account backfill and the full BAS chart) so
 * the client-side proposal helpers can import them without that closure.
 */

import type { EntityType, VatTreatment } from '@/types'

/**
 * Stable code for the "foreign-currency customer invoice without a rate"
 * refusal. Registered in lib/errors/structured-errors.ts so REST routes, the
 * MCP server and getErrorMessage() all translate it the same way.
 *
 * Sales-side twin of SI_FX_RATE_MISSING (supplier-invoice-entries.ts).
 */
export const INVOICE_FX_RATE_MISSING = 'INVOICE_FX_RATE_MISSING' as const

/**
 * Raised when an invoice booking path is asked to translate a foreign-currency
 * amount that has no usable exchange rate.
 *
 * The generators below derive every FX leg from the per-item amounts, and items
 * carry no `*_sek` column: `exchange_rate` is the only SEK source they have. The
 * old per-file fallback returned the RAW foreign amount, and because the 1510
 * debit is derived from the sum of the credits on the FX branch, every leg was
 * scaled by the same wrong factor: the verifikation still balanced, no DB
 * trigger fired and nothing errored. A 1 000 EUR sale posted 1 000 kr to 3001
 * and 250 kr to 2611 instead of 11 500 kr and 2 875 kr at 11,50 SEK/EUR,
 * understating ruta 05 and ruta 10 of the momsdeklaration by the same amount:
 * an oriktig uppgift exposed to skattetillägg under SFL 49 kap 4 §.
 *
 * Refusing instead of guessing follows the `match_batch_allocate` RPC
 * (BATCH_FX_RATE_MISSING) and `toSekOrThrow()` in supplier-invoice-entries.ts.
 *
 * The same refusal covers the header-level fallbacks (no-items bookings and
 * the payment entry) via `headerToSekOrThrow` below: those paths DO honour a
 * populated `*_sek` column, so only rows with no SEK source at all refuse.
 */
export class InvoiceFxRateMissingError extends Error {
  readonly code = INVOICE_FX_RATE_MISSING
  constructor(public readonly currency: string) {
    super(
      `Invoice is in ${currency} but has no exchange rate on file; refusing to post it as if 1 ${currency} = 1 SEK.`
    )
    this.name = 'InvoiceFxRateMissingError'
  }
}

/**
 * Get the appropriate revenue account based on VAT treatment
 *
 * For 'exempt': AB uses 3004 (Försäljning inom Sverige, momsfri),
 * EF uses 3100 (Momsfria intäkter, mapped to R2 in NE engine).
 */
export function getRevenueAccount(vatTreatment: VatTreatment, entityType: EntityType = 'enskild_firma'): string {
  switch (vatTreatment) {
    case 'standard_25':
      return '3001' // Försäljning 25%
    case 'reduced_12':
      return '3002' // Försäljning 12%
    case 'reduced_6':
      return '3003' // Försäljning 6%
    case 'reverse_charge':
      return '3308' // Försäljning tjänst EU
    case 'export':
      return '3305' // Försäljning tjänst Export
    case 'exempt':
      return entityType === 'aktiebolag' ? '3004' : '3100'
    default:
      return '3001'
  }
}

/**
 * Get the output VAT account based on VAT treatment
 */
export function getOutputVatAccount(vatTreatment: VatTreatment): string {
  switch (vatTreatment) {
    case 'standard_25':
      return '2611'
    case 'reduced_12':
      return '2621'
    case 'reduced_6':
      return '2631'
    default:
      return '2611'
  }
}
