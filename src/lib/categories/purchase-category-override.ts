/**
 * A person's purchase category for an inbox item is final: it is stored on
 * the reading (invoice_inbox_items.extracted_data.purchaseCategory) and must
 * survive every write that replaces the reading wholesale, an agent's own
 * extraction (gnubok_set_inbox_extracted_data), a "Tolka om" retry and the
 * deferred first extraction alike. Merging writes (a field correction) keep
 * it by spreading the reading; replacing writes pass their new reading
 * through keepPersonPurchaseCategory (with a person's corrected fields:
 * keepPersonChoices, lib/documents/person-corrections.ts).
 *
 * Light on purpose (no database module, no proposal engine): every
 * extraction path imports it.
 */
import { isPurchaseCategoryCode, type PurchaseCategoryCode } from './purchase-categories'

/** A person's choice as stored on the reading. */
export interface StoredPurchaseCategory {
  code: PurchaseCategoryCode
  source: 'person'
  set_at: string
  /**
   * The door the choice came through: approval is a staged proposal
   * (gnubok_set_inbox_purchase_category, or v1 with ?stage=true) that a
   * person approved. Lives in the jsonb reading only, so no CHECK holds it.
   */
  set_via?: 'dashboard' | 'api' | 'approval'
}

function isPersonChoice(value: unknown): value is { source: 'person'; code: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { source?: unknown }).source === 'person' &&
    typeof (value as { code?: unknown }).code === 'string'
  )
}

/** The person's choice stored on a reading, when it names a code of the taxonomy. */
export function readPurchaseCategoryOverride(extracted: Record<string, unknown> | null | undefined): PurchaseCategoryCode | null {
  const stored = extracted?.purchaseCategory
  if (!isPersonChoice(stored)) return null
  return isPurchaseCategoryCode(stored.code) ? stored.code : null
}

/**
 * The replacement reading with the previous reading's person choice carried
 * over. A replacement that names purchaseCategory itself (set, or null to
 * clear) is the caller's explicit word and wins; a choice that is not a
 * person's is not carried. Pure.
 */
export function keepPersonPurchaseCategory<T extends object>(previous: unknown, next: T): T {
  if (Object.prototype.hasOwnProperty.call(next, 'purchaseCategory')) return next
  const stored =
    previous && typeof previous === 'object' ? (previous as Record<string, unknown>).purchaseCategory : undefined
  if (!isPersonChoice(stored)) return next
  return { ...next, purchaseCategory: stored }
}
