/**
 * Ingest finisher: inbound rows may pay an invoice the collections provider
 * is pursuing, so the batch's inserted inbound rows are checked right after
 * the request answers (scheduleCollectionSweep pauses the case if so). It
 * explains no row itself, and it runs for every batch, a raw insert too.
 */
import type { IngestMatcher } from '@/lib/transactions/ingest-matcher'
import { scheduleCollectionSweep } from './sweep-hook'

export const collectionsSweepIngestMatcher: IngestMatcher = {
  id: 'collections-sweep',
  order: 900,
  module: 'collections',
  direction: 'income',
  onReread: false,
  async match() {
    return 'none'
  },
  finish(batch, _state, inboundIds) {
    scheduleCollectionSweep(batch.companyId, inboundIds)
  },
}
