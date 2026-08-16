/**
 * Supplier auto-matching for extracted documents (inbox items, uploads, MCP).
 *
 * Every extraction path used to inline the same two lookups: exact org_number,
 * then case-insensitive full name. That works for Swedish suppliers and fails
 * for every foreign one, because the extractor deliberately leaves orgNumber
 * null unless the document carries a real Swedish organisationsnummer (see
 * extensions/general/invoice-inbox/lib/extract-invoice-fields.ts). A supplier
 * like "ADOBE SYSTEMS SOFTWARE IRELAND LTD" only ever prints a
 * momsregistreringsnummer (IE6364992H), which the suppliers table stores in
 * vat_number and which nothing looked at, so an exact name match was the sole
 * remaining key and any rename or OCR variant broke the link.
 *
 * This module is the single implementation: org_number, then vat_number, then
 * name. Matching is best-effort and never throws: a failed lookup leaves the
 * item unmatched for the user to link by hand, it does not fail the upload.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

export type SupplierIdentity = {
  orgNumber?: string | null
  vatNumber?: string | null
  name?: string | null
}

/** Same shape with every key present: what supplierIdentityFrom() guarantees. */
export type ResolvedSupplierIdentity = Required<{
  [K in keyof SupplierIdentity]: string | null
}>

/** How a match was found. Callers log this; it is not persisted. */
export type SupplierMatchKey = 'org_number' | 'vat_number' | 'name'

export type SupplierMatch = {
  supplierId: string
  matchedOn: SupplierMatchKey
}

/**
 * Canonical key for a VAT registration number. Registration numbers are
 * printed with spaces, dots and hyphens in every combination ("SE 556012-5790
 * 01", "IE6364992H"), none of which carry identity, so the key is the
 * uppercased alphanumerics. Returns null for values too short to be an
 * identifier at all ("SE", "VAT", "-"), which keeps junk in the column from
 * matching other junk.
 */
export function vatNumberKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return key.length >= 6 ? key : null
}

/** The ISO country code an EU VAT number leads with, when present. */
const COUNTRY_PREFIX = /^[A-Z]{2}(?=[0-9])/

function withoutCountryPrefix(key: string): string | null {
  return COUNTRY_PREFIX.test(key) ? key.slice(2) : null
}

/**
 * True when two VAT numbers denote the same registration.
 *
 * Beyond canonical equality this accepts the prefix-vs-no-prefix pair
 * ("SE556012579001" vs "556012579001"): suppliers are often typed in from a
 * Swedish invoice without the country code while the extractor is instructed
 * to always include it. The relaxation only fires when exactly ONE side
 * carries a prefix, so IE6364992H and SE6364992H stay distinct.
 */
export function vatNumbersMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const keyA = vatNumberKey(a)
  const keyB = vatNumberKey(b)
  if (!keyA || !keyB) return false
  if (keyA === keyB) return true
  const bareA = withoutCountryPrefix(keyA)
  const bareB = withoutCountryPrefix(keyB)
  if (bareA && !bareB) return bareA === keyB
  if (bareB && !bareA) return bareB === keyA
  return false
}

/**
 * Escape the LIKE metacharacters before a name goes into .ilike(). A supplier
 * named "100 % Solutions" or "Foo_Bar" would otherwise be a wildcard pattern
 * and match the wrong row.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Resolve an extracted supplier identity to a supplier in this company.
 *
 * Order is strongest-key-first: org_number is exact and unique, vat_number is
 * exact once normalised, name is a heuristic that legal-form suffixes and OCR
 * casing routinely break. Returns null when nothing matches.
 */
export async function matchSupplierByIdentity(
  supabase: SupabaseClient,
  companyId: string,
  identity: SupplierIdentity,
): Promise<SupplierMatch | null> {
  if (identity.orgNumber) {
    const { data } = await supabase
      .from('suppliers')
      .select('id')
      .eq('company_id', companyId)
      .eq('org_number', identity.orgNumber)
      .limit(1)
      .maybeSingle()
    if (data) return { supplierId: data.id as string, matchedOn: 'org_number' }
  }

  // Normalising in SQL is not possible through PostgREST, so the comparison
  // happens here over the suppliers that have a vat_number at all: a small
  // set even for companies with thousands of suppliers.
  if (vatNumberKey(identity.vatNumber)) {
    try {
      const rows = await fetchAllRows<{ id: string; vat_number: string | null }>(
        ({ from, to }) =>
          supabase
            .from('suppliers')
            .select('id, vat_number')
            .eq('company_id', companyId)
            .not('vat_number', 'is', null)
            .order('id', { ascending: true })
            .range(from, to),
      )
      const hit = rows.find((row) => vatNumbersMatch(row.vat_number, identity.vatNumber))
      if (hit) return { supplierId: hit.id, matchedOn: 'vat_number' }
    } catch (error) {
      // Best-effort: fall through to the name lookup rather than fail the
      // extraction that called us.
      console.error('[match-supplier] vat_number lookup failed:', error)
    }
  }

  if (identity.name) {
    const { data } = await supabase
      .from('suppliers')
      .select('id')
      .eq('company_id', companyId)
      .ilike('name', escapeLikePattern(identity.name))
      .limit(1)
      .maybeSingle()
    if (data) return { supplierId: data.id as string, matchedOn: 'name' }
  }

  return null
}

/**
 * Read a supplier identity out of a loosely-typed `extracted_data.supplier`
 * blob (MCP callers hold it as Record<string, unknown>, not the Zod type).
 *
 * `organizationNumber` is accepted alongside the schema's `orgNumber` because
 * the MCP inbox resolver has always read that spelling, and agent-supplied
 * extracted_data may still use it.
 */
export function supplierIdentityFrom(raw: unknown): ResolvedSupplierIdentity {
  const supplier = (raw ?? {}) as Record<string, unknown>
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null
  return {
    orgNumber: str(supplier.orgNumber) ?? str(supplier.organizationNumber),
    vatNumber: str(supplier.vatNumber),
    name: str(supplier.name),
  }
}

/** Convenience wrapper for the call sites that only persist the id. */
export async function matchSupplierId(
  supabase: SupabaseClient,
  companyId: string,
  identity: SupplierIdentity,
): Promise<string | null> {
  const match = await matchSupplierByIdentity(supabase, companyId, identity)
  return match?.supplierId ?? null
}
