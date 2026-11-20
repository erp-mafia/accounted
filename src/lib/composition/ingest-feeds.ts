/**
 * The bank feeds whose rows ingestTransactions treats by their import_source
 * (contract: lib/transactions/ingest-feed.ts): a hand-written static list, no
 * lazy registration, no lib/init, no event bus. Each feed lives with the
 * block that owns it.
 */
import type { IngestFeed } from '@/lib/transactions/ingest-feed'
import { openPaymentsIngestFeed } from '@/lib/bank-feed/ingest-feed'

export const INGEST_FEEDS: readonly IngestFeed[] = Object.freeze<IngestFeed[]>([openPaymentsIngestFeed])
