/**
 * Open Payments as ingest sees it (contract: lib/transactions/ingest-feed.ts;
 * list: lib/composition/ingest-feeds.ts). Its rows carry import_source
 * 'open_payments' (lib/bank-feed/sync.ts). A sync re-reads rows it already
 * delivered and adds what the bank enriched since (value date, end-to-end id,
 * counterparty), and a bankgiro deposit or payout arrives with its split.
 */
import type { IngestFeed } from '@/lib/transactions/ingest-feed'
import { OPEN_PAYMENTS_AGGREGATOR } from '@/lib/bank-sync/aggregator'

export const openPaymentsIngestFeed: IngestFeed = Object.freeze<IngestFeed>({
  importSource: OPEN_PAYMENTS_AGGREGATOR,
  module: 'bank-feed',
  rereadsStoredRows: true,
  carriesSplits: true,
})
