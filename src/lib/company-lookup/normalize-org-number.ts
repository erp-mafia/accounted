/**
 * Org-number normalization for the company-lookup boundary.
 *
 * The rule moved to `lib/invariants/org-number.ts`, where it sits with the
 * other shared format contracts and with the Skatteverket-bound converters that
 * have to agree with it. Re-exported here because this is where the lookup,
 * TIC-refresh, VAT-number and årsredovisning callers import it from.
 */
export { normalizeOrgNumber } from '@/lib/invariants/org-number'
