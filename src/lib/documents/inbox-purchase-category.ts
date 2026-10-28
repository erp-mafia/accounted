/**
 * A person's own purchase category for an invoice-inbox item: what they say
 * the underlag bought, over whatever the proposal reads into it.
 *
 * Stored on the reading as extracted_data.purchaseCategory = { code, source:
 * 'person', set_at, set_via }, merged into the jsonb like a field correction
 * (lib/documents/inbox-item-actions.ts): nothing else on the reading changes,
 * and the write runs under optimistic concurrency on updated_at. Clearing it
 * (code null) removes the key, so the item reads the proposal again.
 *
 * The same rules as correcting the reading: an item converted to a supplier
 * invoice is frozen, and an item without a reading of its own has nothing to
 * hold the choice (its document's reading only stands in for display).
 *
 * "Varje gång" (every_time): the choice also becomes the instruction for
 * the item's matched supplier (suppliers.default_purchase_category), which
 * later items from that supplier read as Ditt val
 * (lib/categories/inbox-purchase-category.ts). It never changes a choice a
 * person made on another single item. With code null it removes the
 * instruction along with this item's choice. An item without a matched
 * supplier has nobody to hold the instruction (INBOX_ITEM_NO_SUPPLIER). The
 * supplier is written first: both writes are idempotent, so a retry after a
 * conflict on the item lands the same state.
 *
 * expectedSupplierId pins the matched supplier: a staged every_time is
 * approved for the supplier its card named, so when the item has been
 * matched to another one since, nothing is written
 * (INBOX_ITEM_SUPPLIER_CHANGED). The dry run of an every_time names that
 * supplier as the register has it (matched_supplier_name).
 *
 * The category books nothing: the account stays the booking's. Every door
 * calls this one function: the dashboard route
 * (PUT /api/extensions/ext/invoice-inbox/items/:id/purchase-category) and
 * the v1 operation inbox-items.set-purchase-category, which MCP stages as
 * gnubok_set_inbox_purchase_category and an approval commits.
 */
import { z } from 'zod'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { UUID_RE } from '@/lib/invariants/uuid'
import {
  resolveInboxPurchaseCategories,
  type InboxPurchaseCategory,
  type StoredPurchaseCategory,
} from '@/lib/categories/inbox-purchase-category'
import { PURCHASE_CATEGORY_CODES, type PurchaseCategoryCode } from '@/lib/categories/purchase-categories'

export const SetInboxPurchaseCategorySchema = z.object({
  code: z
    .enum(PURCHASE_CATEGORY_CODES)
    .nullable()
    .describe('A purchase-category code (e.g. "expense.software.saas"), or null to clear the choice and read the proposal again.'),
  every_time: z
    .boolean()
    .optional()
    .describe(
      'true: also make it the instruction for the item\'s matched supplier, so later items from that supplier are proposed this category as "Ditt val" (null removes the instruction). Never changes a choice made on another single item. Omitted or false: this item only.',
    ),
})

export interface SetInboxPurchaseCategoryResult {
  id: string
  /** What the item reads after the write: the person's choice, or the proposal once cleared. */
  purchase_category: InboxPurchaseCategory | null
}

/**
 * What names the underlag on a dry run's preview, read off its reading: the
 * supplier and the invoice number, each only when the reading has one. A
 * staged choice is approved by someone who did not make it, and an id tells
 * them nothing. Pure.
 */
export function readingLabel(extracted: Record<string, unknown>): { supplier_name?: string; invoice_number?: string } {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  const supplier = extracted.supplier as Record<string, unknown> | null | undefined
  const invoice = extracted.invoice as Record<string, unknown> | null | undefined
  const supplierName = text(supplier?.name)
  const invoiceNumber = text(invoice?.invoiceNumber)
  return {
    ...(supplierName ? { supplier_name: supplierName } : {}),
    ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
  }
}

/** The reading with the person's choice set, or removed for null. Pure. */
export function withPurchaseCategory(
  current: Record<string, unknown>,
  code: PurchaseCategoryCode | null,
  setAt: string,
  via: NonNullable<StoredPurchaseCategory['set_via']>,
): Record<string, unknown> {
  const { purchaseCategory: _previous, ...rest } = current
  if (code === null) return rest
  const stored: StoredPurchaseCategory = { code, source: 'person', set_at: setAt, set_via: via }
  return { ...rest, purchaseCategory: stored }
}

export async function setInboxItemPurchaseCategory(
  ctx: OperationContext,
  inboxItemId: string,
  code: PurchaseCategoryCode | null,
  options: {
    via: NonNullable<StoredPurchaseCategory['set_via']>
    everyTime?: boolean
    /** The supplier the item must still be matched to; any other match refuses, writing nothing. */
    expectedSupplierId?: string
    dryRun?: boolean
    now?: Date
  },
): Promise<OperationOutcome<SetInboxPurchaseCategoryResult>> {
  if (!UUID_RE.test(inboxItemId)) return { ok: false, code: 'INBOX_ITEM_NOT_FOUND' }
  const { data: item, error: fetchError } = await ctx.supabase
    .from('invoice_inbox_items')
    .select('id, extracted_data, matched_supplier_id, created_supplier_invoice_id, updated_at')
    .eq('id', inboxItemId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (fetchError) return { ok: false, code: 'UNKNOWN_ERROR', error: fetchError }
  if (!item) return { ok: false, code: 'INBOX_ITEM_NOT_FOUND' }
  const row = item as {
    id: string
    extracted_data: Record<string, unknown> | null
    matched_supplier_id: string | null
    created_supplier_invoice_id: string | null
    updated_at: string
  }
  if (row.created_supplier_invoice_id) {
    return { ok: false, code: 'INBOX_ITEM_EDIT_LOCKED', details: { supplier_invoice_id: row.created_supplier_invoice_id } }
  }
  if (!row.extracted_data) return { ok: false, code: 'INBOX_ITEM_NO_READING' }
  if (options.expectedSupplierId !== undefined && row.matched_supplier_id !== options.expectedSupplierId) {
    return {
      ok: false,
      code: 'INBOX_ITEM_SUPPLIER_CHANGED',
      details: { expected_supplier_id: options.expectedSupplierId, matched_supplier_id: row.matched_supplier_id },
    }
  }
  const everyTime = options.everyTime === true
  if (everyTime && !row.matched_supplier_id) return { ok: false, code: 'INBOX_ITEM_NO_SUPPLIER' }

  const next = withPurchaseCategory(row.extracted_data, code, (options.now ?? new Date()).toISOString(), options.via)

  if (options.dryRun) {
    let matchedSupplierName: string | null = null
    if (everyTime) {
      // The supplier the instruction would land on, by its name in the register.
      const { data: supplier, error: supplierError } = await ctx.supabase
        .from('suppliers')
        .select('id, name')
        .eq('id', row.matched_supplier_id as string)
        .eq('company_id', ctx.companyId)
        .maybeSingle()
      if (supplierError) return { ok: false, code: 'UNKNOWN_ERROR', error: supplierError }
      if (!supplier) return { ok: false, code: 'INBOX_ITEM_NO_SUPPLIER' }
      const name = (supplier as { name: string | null }).name
      matchedSupplierName = typeof name === 'string' && name.trim() ? name.trim() : null
    }
    return {
      ok: true,
      dryRun: true,
      preview: {
        inbox_item_id: row.id,
        purchase_category_code: code,
        ...readingLabel(row.extracted_data),
        ...(everyTime
          ? {
              every_time: true,
              supplier_id: row.matched_supplier_id,
              ...(matchedSupplierName ? { matched_supplier_name: matchedSupplierName } : {}),
            }
          : {}),
      },
    }
  }

  if (everyTime) {
    const { data: supplier, error: supplierError } = await ctx.supabase
      .from('suppliers')
      .update({ default_purchase_category: code })
      .eq('id', row.matched_supplier_id as string)
      .eq('company_id', ctx.companyId)
      .select('id')
      .maybeSingle()
    if (supplierError) return { ok: false, code: 'UNKNOWN_ERROR', error: supplierError }
    // Gone, or not this person's to change: nothing was written.
    if (!supplier) return { ok: false, code: 'INBOX_ITEM_NO_SUPPLIER' }
  }

  const { data: updated, error: updateError } = await ctx.supabase
    .from('invoice_inbox_items')
    .update({ extracted_data: next })
    .eq('id', inboxItemId)
    .eq('company_id', ctx.companyId)
    .eq('updated_at', row.updated_at)
    .select('id')
    .maybeSingle()
  if (updateError) return { ok: false, code: 'UNKNOWN_ERROR', error: updateError }
  if (!updated) return { ok: false, code: 'INBOX_ITEM_EDIT_CONFLICT' }

  const read = await resolveInboxPurchaseCategories(ctx.supabase, ctx.companyId, [
    { id: row.id, extracted_data: next, matched_supplier_id: row.matched_supplier_id },
  ])
  return { ok: true, data: { id: row.id, purchase_category: read.get(row.id) ?? null } }
}
