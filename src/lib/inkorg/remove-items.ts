/**
 * Removing several items from the Inkorg at once (POST /api/inkorg/items/remove):
 * the bound one request takes, the shape of its answer, what the confirm
 * says about undoing it, and how the page sums the answer up for the person.
 * No imports: the page and the request schema both read this.
 */

/** The most items one request takes; the page sends a larger selection in parts. */
export const MAX_INBOX_ITEMS_PER_REMOVAL = 200

/** One item's outcome: gone, or refused with the code and words the single removal answers. */
export type InboxItemRemovalResult =
  | { id: string; removed: true }
  | { id: string; removed: false; code: string; message: string; message_en: string }

/**
 * What the confirm of a removal of several says about undoing it, as a
 * message of the inkorg namespace: Senast borttagna when every picked item
 * can be put back, "cannot be undone" when none can, and both numbers for a
 * mix. `putBack` is how many of the `count` picked items can come back
 * (removalCanBePutBack, lib/documents/inbox-item-state.ts): the confirm never
 * promises a way back for an item that keeps no copy.
 */
export function removalUndoSentence(
  count: number,
  putBack: number,
):
  | { key: 'bulk_drop_confirm_body_put_back' | 'bulk_drop_confirm_body'; values: { count: number } }
  | { key: 'bulk_drop_confirm_body_mixed'; values: { putBack: number; final: number } } {
  if (putBack >= count) return { key: 'bulk_drop_confirm_body_put_back', values: { count } }
  if (putBack <= 0) return { key: 'bulk_drop_confirm_body', values: { count } }
  return { key: 'bulk_drop_confirm_body_mixed', values: { putBack, final: count - putBack } }
}

/** The ids in parts no larger than one request takes, in order. */
export function removalBatches(ids: readonly string[], size: number = MAX_INBOX_ITEMS_PER_REMOVAL): string[][] {
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size))
  return batches
}

export interface RemovalSummary {
  removedIds: string[]
  /** What was not removed, one line per reason, most common first. */
  refused: { code: string; message: string; count: number }[]
  refusedCount: number
}

/** The answers of one or more requests as what the person reads: how many left, and why the rest did not. */
export function summariseRemovals(results: readonly InboxItemRemovalResult[], locale: 'sv' | 'en'): RemovalSummary {
  const removedIds: string[] = []
  const byCode = new Map<string, { code: string; message: string; count: number }>()
  for (const result of results) {
    if (result.removed) {
      removedIds.push(result.id)
      continue
    }
    const reason = byCode.get(result.code)
    if (reason) reason.count += 1
    else byCode.set(result.code, { code: result.code, message: locale === 'en' ? result.message_en : result.message, count: 1 })
  }
  const refused = [...byCode.values()].sort((a, b) => b.count - a.count)
  return { removedIds, refused, refusedCount: results.length - removedIds.length }
}
