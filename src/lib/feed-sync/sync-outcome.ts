/**
 * Turn a connector sync route's success body into the single sentence the
 * settings panel shows, for every cursor-based feed (Shopify, WooCommerce,
 * Zettle, Stripe). Each panel carried its own copy of this ladder; the
 * connectors differ only in which field counts the new rows and which extra
 * counts their sentences name.
 *
 * Browser-safe: no server imports.
 */

/** The sync summary over the wire; connectors add their own counts. */
export interface FeedSyncWire {
  fetched?: number
  /** New rows this run, for the connectors whose summary says inserted. */
  inserted?: number
  /** New rows this run, for the connectors whose summary says imported. */
  imported?: number
  errors?: number
  revoked?: boolean
  deadlineReached?: boolean
  [count: string]: unknown
}

/** Success body of POST /api/extensions/ext/<id>/sync and /backfill. */
export interface FeedSyncPayload {
  success?: boolean
  transactions?: FeedSyncWire | null
}

/**
 * A type alias, not an interface: next-intl's `t(key, values)` takes a
 * `Record<string, string | number | Date>`, and only anonymous object types get
 * the implicit index signature that makes them assignable to it.
 */
export type FeedSyncCounts = { fetched: number; imported: number } & Record<string, number>

export type FeedSyncOutcome =
  /** The provider refused the connection; it was flipped to revoked. */
  | { reason: 'revoked' }
  /** The window genuinely held nothing. A real answer, not a silent success. */
  | { reason: 'empty' }
  /**
   * The time budget ran out with rows still unfetched. Reported before the
   * count-based outcomes so a truncated run never reads as a complete one;
   * the cursor persisted, so pressing sync again continues where it stopped.
   */
  | { reason: 'partial'; values: FeedSyncCounts & { errors: number } }
  /** Rows landed, and some rows did not. Both halves get said. */
  | { reason: 'errors'; values: FeedSyncCounts & { errors: number } }
  /** Rows landed. */
  | { reason: 'feed'; values: FeedSyncCounts }
  /** 2xx whose body could not be read: the sync ran, the counts are unknown. */
  | { reason: 'unknown' }

export interface FeedSyncOutcomeOptions {
  /** The summary field that counts new rows ("imported" in the sentence). */
  importedField: 'inserted' | 'imported'
  /** Further counts the connector's sentences name, zero when absent. */
  extraCounts?: readonly string[]
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

export function feedSyncOutcome(
  payload: FeedSyncPayload | null,
  options: FeedSyncOutcomeOptions,
): FeedSyncOutcome {
  const summary = payload?.transactions
  if (!summary) return { reason: 'unknown' }
  if (summary.revoked === true) return { reason: 'revoked' }
  if (typeof summary.fetched !== 'number') return { reason: 'unknown' }

  const fetched = summary.fetched
  const imported = count(summary[options.importedField])
  const errors = count(summary.errors)
  const extra: Record<string, number> = {}
  for (const field of options.extraCounts ?? []) extra[field] = count(summary[field])

  if (summary.deadlineReached === true) {
    return { reason: 'partial', values: { fetched, imported, ...extra, errors } }
  }
  if (fetched === 0) return { reason: 'empty' }
  if (errors > 0) return { reason: 'errors', values: { fetched, imported, ...extra, errors } }
  return { reason: 'feed', values: { fetched, imported, ...extra } }
}
