import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { InvoiceWriteItemRow } from '@/lib/invoices/build-invoice-write'

/**
 * Replace ALL invoice_items rows of a DRAFT invoice with `items` (full-replace
 * semantics: delete everything, then insert the new set with `invoice_id`
 * stamped on).
 *
 * Only valid for editable drafts: a draft has no journal entry or linked
 * documents, so delete + reinsert is safe and lets the caller add / remove /
 * reorder rows freely (invoice_items cascade nothing else). The caller is
 * responsible for the draft guard (isEditableInvoiceDraft) BEFORE calling.
 *
 * Delete + insert is not atomic over PostgREST, so the existing rows are
 * snapshotted first and best-effort restored when the insert fails: without
 * that, a rejected insert (constraint violation, transient error) left the
 * draft with ZERO items and the user's line content gone. Same
 * snapshot/restore idiom as commitUpdateRecurringSchedule in
 * lib/pending-operations/commit.ts. `restored` on the insert-failure shape
 * says whether the previous rows are back; the success path is unchanged.
 *
 * Shared by the cookie PATCH route (app/api/invoices/[id]), the v1 REST PATCH
 * route, and the update_invoice commit executor so the replace logic cannot
 * drift between the surfaces.
 */
export type ReplaceInvoiceItemsResult =
  | { ok: true }
  /**
   * Refused before any write: the draft was created from a kundorder and the
   * new line set drops one or more sales_order_item_id links. The order's
   * invoiced quantity is derived from those links, so losing them would free
   * the quantity for a second invoice. Every caller (cookie PATCH, v1 PATCH,
   * update_invoice executor) surfaces this as INVOICE_UPDATE_DROPS_ORDER_LINK.
   */
  | { ok: false; stage: 'guard'; code: 'INVOICE_UPDATE_DROPS_ORDER_LINK'; messageSv: string }
  | { ok: false; stage: 'delete'; error: PostgrestError }
  | {
      ok: false
      stage: 'insert'
      error: PostgrestError
      /**
       * Whether the pre-delete rows were put back after the failed insert.
       * True when the restore insert succeeded (or there was nothing to
       * restore); false when the draft may have been left without items and
       * the caller should say so instead of reporting a clean failure.
       */
      restored: boolean
    }

/** Server-generated invoice_items columns that must not be re-inserted. */
const SERVER_GENERATED_COLUMNS = ['id', 'created_at', 'updated_at'] as const

export async function replaceInvoiceItems(
  supabase: SupabaseClient,
  invoiceId: string,
  items: InvoiceWriteItemRow[],
): Promise<ReplaceInvoiceItemsResult> {
  // Snapshot before deleting. select('*') on purpose: the restore must carry
  // every content column, including ones added after this function was
  // written, so an explicit list here would silently drop new fields.
  const { data: snapshotRows, error: snapshotError } = await supabase
    .from('invoice_items')
    .select('*')
    .eq('invoice_id', invoiceId)

  // Order-link guard: a line set that forgets sales_order_item_id (a client
  // that read the lines through a projection without it, or a header-only
  // edit path that re-reads a narrow column list) must not silently sever
  // the kundorder link. Compare the link multiset before deleting anything.
  if (!snapshotError && snapshotRows) {
    const existingLinks = (snapshotRows as Array<{ sales_order_item_id?: string | null }>)
      .map((row) => row.sales_order_item_id)
      .filter((id): id is string => typeof id === 'string')
    if (existingLinks.length > 0) {
      const incoming = new Map<string, number>()
      for (const item of items) {
        const link = (item as { sales_order_item_id?: string | null }).sales_order_item_id
        if (link) incoming.set(link, (incoming.get(link) ?? 0) + 1)
      }
      for (const link of existingLinks) {
        const left = incoming.get(link) ?? 0
        if (left === 0) {
          return {
            ok: false,
            stage: 'guard',
            code: 'INVOICE_UPDATE_DROPS_ORDER_LINK',
            messageSv:
              'Fakturan är skapad från en kundorder och ändringen skulle tappa kopplingen till orderraderna.',
          }
        }
        incoming.set(link, left - 1)
      }
    }
  }

  const { error: deleteError } = await supabase
    .from('invoice_items')
    .delete()
    .eq('invoice_id', invoiceId)

  if (deleteError) return { ok: false, stage: 'delete', error: deleteError }

  const { error: insertError } = await supabase
    .from('invoice_items')
    .insert(items.map((item) => ({ ...item, invoice_id: invoiceId })))

  if (insertError) {
    // Best-effort restore of the snapshot so the draft keeps its lines. A
    // failed (or impossible) restore is reported, never swallowed.
    let restored = false
    if (snapshotError || snapshotRows == null) {
      restored = false
    } else if (snapshotRows.length === 0) {
      // Nothing existed before, so the draft is already in its prior state.
      restored = true
    } else {
      const restoreRows = (snapshotRows as Record<string, unknown>[]).map((row) => {
        const copy: Record<string, unknown> = { ...row }
        for (const column of SERVER_GENERATED_COLUMNS) delete copy[column]
        copy.invoice_id = invoiceId
        return copy
      })
      const { error: restoreError } = await supabase
        .from('invoice_items')
        .insert(restoreRows)
      restored = !restoreError
    }
    return { ok: false, stage: 'insert', error: insertError, restored }
  }

  return { ok: true }
}
