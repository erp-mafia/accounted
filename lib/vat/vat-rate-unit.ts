// Leaf module on purpose: imported by extension entry graphs (arcim-migration
// entity mapper) where pulling in supplier-invoice-line-checks' dependencies
// (lib/money) shifted the server chunk graph into a Turbopack chunk-name hash
// collision ("Two or more assets with different content were emitted to the
// same output path", first seen on the #1385 merge). Keep this file free of
// imports; supplier-invoice-line-checks re-exports it for all other callers.

/**
 * Convert a supplier-invoice VAT rate to the database's decimal-fraction
 * unit without changing the underlying rate. Values above 1 are interpreted
 * as percentages, while values already between 0 and 1 pass through. This is
 * intentionally a unit normalizer, not a Swedish-rate validator: imported
 * foreign VAT such as 19 % must remain 0.19 instead of being rewritten.
 */
export function normalizeVatRateToFraction(rate: unknown): number {
  const n = Number(rate)
  if (!Number.isFinite(n) || n < 0) return 0

  const fraction = n > 1 ? n / 100 : n
  return fraction <= 1 ? fraction : 0
}
