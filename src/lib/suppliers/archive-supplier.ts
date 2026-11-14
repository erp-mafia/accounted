/**
 * Supplier (leverantör) archive: the one write path behind the v1
 * DELETE /suppliers/:id and the MCP gnubok_archive_supplier (operation
 * suppliers.archive, lib/operations/suppliers.ts).
 *
 * The rule was written inline in the v1 route and had no MCP door, so an
 * agent that found a duplicate supplier after an import could neither archive
 * it nor ask a person to (crm#1796). The rule lives here now; the doors only
 * translate.
 *
 * Archiving is a soft delete: archived_at is set and the row stays, with its
 * supplier invoices and history. Un-archive with suppliers.update
 * (archived_at: null).
 */
import { UUID_RE } from '@/lib/invariants/uuid'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { tolerateMissingDefaultDimensions } from '@/lib/suppliers/default-dimensions'
import { SUPPLIER_RECORD_COLUMNS, readSupplierRecord, type SupplierRecord } from '@/lib/suppliers/supplier-record'

/**
 * A supplier with an invoice in one of these states is not archived: the
 * supplier record is where the seller's name and address live for an invoice
 * still to be paid, credited or settled. `disputed` is included so a held
 * supplier invoice still blocks archive: the seller record may still be
 * needed if the dispute resolves into a kreditfaktura or partial payment.
 */
export const OPEN_SUPPLIER_INVOICE_STATUSES = [
  'registered',
  'approved',
  'partially_paid',
  'overdue',
  'disputed',
] as const

const NOT_FOUND: Extract<OperationOutcome<never>, { ok: false }> = { ok: false, code: 'SUPPLIER_NOT_FOUND' }

/**
 * Archives one supplier. Refused with SUPPLIER_HAS_INVOICES while it has an
 * open supplier invoice (details.open_invoice_count). The dry run answers the
 * record as it would read archived and writes nothing. Archiving an archived
 * supplier goes through again.
 */
export async function archiveSupplier(
  ctx: OperationContext,
  supplierId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<SupplierRecord>> {
  const { supabase, companyId, log } = ctx
  // A non-UUID id can never match a row: 404, not a uuid cast error.
  if (!UUID_RE.test(supplierId)) return NOT_FOUND

  const { count: openInvoiceCount, error: openError } = await supabase
    .from('supplier_invoices')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('supplier_id', supplierId)
    .in('status', [...OPEN_SUPPLIER_INVOICE_STATUSES])
  if (openError) return { ok: false, code: 'SUPPLIER_UPDATE_FAILED', error: openError }
  if ((openInvoiceCount ?? 0) > 0) {
    return { ok: false, code: 'SUPPLIER_HAS_INVOICES', details: { open_invoice_count: openInvoiceCount } }
  }

  const archivedAt = new Date().toISOString()

  if (options.dryRun) {
    const { data: current, error: readError } = await readSupplierRecord(supabase, companyId, supplierId)
    if (readError) return { ok: false, code: 'SUPPLIER_UPDATE_FAILED', error: readError }
    if (!current) return NOT_FOUND
    return { ok: true, dryRun: true, preview: { ...current, supplier_id: supplierId, archived_at: archivedAt } }
  }

  // is_active is the legacy flag the dashboard filters still read: it
  // follows every archive and un-archive.
  const { data, error } = await tolerateMissingDefaultDimensions(SUPPLIER_RECORD_COLUMNS, (columns) =>
    supabase
      .from('suppliers')
      .update({ archived_at: archivedAt, is_active: false })
      .eq('company_id', companyId)
      .eq('id', supplierId)
      .select(columns)
      .maybeSingle(),
  )
  if (error) {
    log.error('supplier archive failed', error)
    return { ok: false, code: 'SUPPLIER_UPDATE_FAILED', error }
  }
  if (!data) return NOT_FOUND
  return { ok: true, data: data as unknown as SupplierRecord }
}
