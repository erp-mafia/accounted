/**
 * A supplier's default dimension bag (suppliers.default_dimensions,
 * accounted#144) and the one rule that applies it: a new supplier invoice
 * takes it as its own default_dimensions when the request names none.
 *
 * Every door that registers a supplier invoice from a request reads it
 * through invoiceDefaultDimensions: createSupplierInvoice (the dashboard and
 * v1 POST), convertInboxItemToSupplierInvoice (the Inkorg's convert, its one
 * click and register-and-settle, the v1 inbox convert) and the MCP staging of
 * gnubok_create_supplier_invoice_from_inbox, which stages the bag so the
 * approver sees it. The dashboard editor prefills its picker from the same
 * column and sends what it shows.
 *
 * A bag sent with the invoice, {} included, is the override: the supplier's
 * default never merges into it. On a line the most specific tag wins: an
 * account's fixed dimension rule, then the item's own bag, then the
 * invoice's bag (sent, else this default), then an account's default rule
 * (lib/bookkeeping/dimension-rules.ts).
 *
 * Not read: a credit note copies the invoice it credits; an invoice
 * registered against a booked verifikat (register-booked.ts) takes that
 * verifikat's tags; a migration import keeps the other system's documents as
 * they were booked there. Learned counterparty rules
 * (categorization_templates.default_dimensions) never tag a supplier
 * invoice: they tag bank-line bookings only, and a supplier invoice's payment
 * takes the invoice's bag, so the two never meet on one line.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { coerceDimensionsBag, validateEntryDimensions, type LineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import { DimensionValidationError, DIMENSION_VALIDATION_FAILED } from '@/lib/bookkeeping/dimension-errors'
import { isMissingColumnError } from '@/lib/pending-operations/agent-reason'
import type { OperationOutcome } from '@/lib/operations/types'

/** The supplier's default bag, normalized; {} for none or a row read without the column. */
export function supplierDefaultDimensions(supplier: { default_dimensions?: unknown } | null | undefined): LineDimensions {
  return coerceDimensionsBag(supplier?.default_dimensions) ?? {}
}

/**
 * The invoice-level bag a new supplier invoice is registered with: the bag
 * the request sent, {} included, else the supplier's default.
 */
export function invoiceDefaultDimensions(
  requested: Record<string, string> | null | undefined,
  supplier: { default_dimensions?: unknown } | null | undefined,
): LineDimensions {
  if (requested !== undefined && requested !== null) return coerceDimensionsBag(requested) ?? {}
  return supplierDefaultDimensions(supplier)
}

/**
 * A bag about to be stored on a supplier, refused when a company with
 * dimensions enabled does not have its codes as active registry values: the
 * same judgement the engine makes when an invoice carrying it is booked, made
 * when the default is set instead of on every invoice after it. Null passes.
 */
export async function refuseUnknownSupplierDimensions(
  supabase: SupabaseClient,
  companyId: string,
  bag: LineDimensions,
): Promise<Extract<OperationOutcome<never>, { ok: false }> | null> {
  if (Object.keys(bag).length === 0) return null
  try {
    await validateEntryDimensions(supabase, companyId, [{ dimensions: bag }])
    return null
  } catch (err) {
    if (err instanceof DimensionValidationError) {
      return { ok: false, code: DIMENSION_VALIDATION_FAILED, details: { field: 'default_dimensions', issues: err.issues }, messageSv: err.message }
    }
    throw err
  }
}

/**
 * Run a supplier query whose column list names default_dimensions; when the
 * database does not know the column yet (Vercel serves main's code up to a
 * few hours before CI applies migration 20261031203517), run it once more
 * with the list without it and read the rows as having no default. A write
 * that still names the column fails the second time too: nothing is dropped
 * quietly.
 */
export async function tolerateMissingDefaultDimensions<R extends { data: unknown; error: { code?: string } | null }>(
  columns: string,
  run: (columns: string) => PromiseLike<R>,
): Promise<R> {
  const first = await run(columns)
  if (!isMissingColumnError(first.error)) return first
  const second = await run(columns.replace(/,\s*default_dimensions\b/, ''))
  const withDefault = (row: unknown) =>
    row && typeof row === 'object' ? { ...(row as Record<string, unknown>), default_dimensions: {} } : row
  const data = Array.isArray(second.data) ? second.data.map(withDefault) : withDefault(second.data)
  return { ...second, data } as R
}
