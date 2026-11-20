/**
 * What ingestTransactions (lib/transactions/ingest.ts) needs to know about the
 * feed a row came from, keyed by the row's import_source: the plug-in point
 * through which a bank feed tells the bank side how its rows behave, so the
 * bank side never names a feed. The static list ingest reads is
 * lib/composition/ingest-feeds.ts; each entry lives with the block that owns
 * the feed. An import_source no entry names gets neither treatment below, as
 * every other source always has.
 *
 * Imports nothing at runtime: the blocks that declare a feed depend on this
 * file's types only.
 */
import type { ModuleId } from '@/lib/modules/manifest'

export interface IngestFeed {
  /** transactions.import_source of the feed's rows. */
  readonly importSource: string
  /** The module that owns the feed. */
  readonly module: ModuleId
  /**
   * The feed re-reads rows it already delivered and adds what the bank
   * enriched since: a batch's stored rows are read whole so a re-read can
   * update them (enrichmentPatch).
   */
  readonly rereadsStoredRows: boolean
  /** A row may carry its Bankgirot split (raw.parts), stored beside the row. */
  readonly carriesSplits: boolean
}

/** True when a feed in `feeds` delivers `importSource` and re-reads its stored rows. */
export function feedRereadsStoredRows(feeds: readonly IngestFeed[], importSource: string | null | undefined): boolean {
  return feeds.some((feed) => feed.rereadsStoredRows && feed.importSource === importSource)
}

/** True when a feed in `feeds` delivers `importSource` and its rows may carry a split. */
export function feedCarriesSplits(feeds: readonly IngestFeed[], importSource: string | null | undefined): boolean {
  return feeds.some((feed) => feed.carriesSplits && feed.importSource === importSource)
}
