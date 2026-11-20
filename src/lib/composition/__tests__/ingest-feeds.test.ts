/**
 * The feeds ingest treats by import_source are a static list: Open Payments
 * alone re-reads its stored rows and carries splits, exactly the rows ingest
 * singled out by name before the list. A change here changes which rows are
 * enriched or split, so it is a change to this test.
 */
import { describe, expect, it } from 'vitest'
import { MODULE_IDS } from '@/lib/modules/manifest'
import { feedCarriesSplits, feedRereadsStoredRows } from '@/lib/transactions/ingest-feed'
import { INGEST_FEEDS } from '../ingest-feeds'

describe('INGEST_FEEDS', () => {
  it('names Open Payments, owned by the bank feed, as the one feed that re-reads and splits', () => {
    expect(INGEST_FEEDS).toEqual([
      { importSource: 'open_payments', module: 'bank-feed', rereadsStoredRows: true, carriesSplits: true },
    ])
    expect(Object.isFrozen(INGEST_FEEDS)).toBe(true)
    for (const feed of INGEST_FEEDS) expect(MODULE_IDS).toContain(feed.module)
  })

  it('answers by import_source, and no for every source the list does not name', () => {
    for (const ask of [feedRereadsStoredRows, feedCarriesSplits]) {
      expect(ask(INGEST_FEEDS, 'open_payments')).toBe(true)
      for (const other of ['enable_banking', 'camt053', 'csv_seb', 'manual', 'mcp', null, undefined]) {
        expect(ask(INGEST_FEEDS, other)).toBe(false)
      }
    }
  })
})
