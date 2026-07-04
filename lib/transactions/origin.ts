/**
 * Transaction origin helpers: distinguish rows the user created INSIDE the app
 * from rows that were fetched/imported from an external feed (bank sync or a
 * bank-file upload).
 *
 * Why this matters
 * ----------------
 * An imported row is an external system's record of money that actually moved.
 * The user may *ignore* it (`is_ignored`) to take it off the to-book /
 * reconciliation lists, but must never be able to *delete* it: deleting would
 * silently drop a real bank line, and the next sync (or a re-import of the same
 * file) would either bring it back as a "new" row or, worse, leave the books
 * out of step with the bank. Only hand-entered rows are the user's to remove.
 *
 * The two import paths that populate `transactions` from outside the app:
 *   - Enable Banking (PSD2) live sync → sets `bank_connection_id`
 *     (and `import_source = 'enable_banking'`). See
 *     `extensions/general/enable-banking/lib/sync.ts`.
 *   - Bank-file import (CSV / CAMT053) → sets `import_source` to `'camt053'` or
 *     `'csv_<format>'` (no live connection). See
 *     `app/api/import/bank-file/execute/route.ts`.
 *
 * Everything else is user-created and therefore deletable (subject to the
 * separate "booked rows are immutable" rule):
 *   - manual add via POST /api/transactions      → `import_source = null`
 *   - create-from-document                        → `import_source = 'manual'`
 *   - MCP / agent create                          → `import_source = 'mcp'`
 *
 * Safe-by-default: this is an ALLOWLIST of known user-created sources. Any other
 * `import_source` tag (including an import feed added in the future) is
 * treated as imported (ignore-only), so a new feed can never accidentally
 * become user-deletable before someone consciously adds it here.
 */

/** Minimal shape: the two columns that record where a transaction came from. */
export type TransactionOrigin = {
  bank_connection_id?: string | null
  import_source?: string | null
}

/**
 * `import_source` values produced by in-app creation flows. A `null` source
 * (with no bank connection) is also user-created: that's the plain manual-add
 * path. Anything NOT in this set is considered an external import feed.
 */
const USER_CREATED_IMPORT_SOURCES: ReadonlySet<string> = new Set(['manual', 'mcp'])

/**
 * True when the transaction was fetched via bank sync or uploaded via a
 * bank-file import, i.e. NOT created by the user inside the app. Such rows are
 * ignore-only and can never be deleted (booked or not).
 */
export function isImportedTransaction(tx: TransactionOrigin): boolean {
  // A live bank connection is the unambiguous PSD2 marker (Enable Banking).
  if (tx.bank_connection_id) return true
  const src = tx.import_source
  // No source and no bank link → a hand-entered row.
  if (src == null) return false
  // Known in-app sources are user-created; everything else is an import feed.
  return !USER_CREATED_IMPORT_SOURCES.has(src)
}
