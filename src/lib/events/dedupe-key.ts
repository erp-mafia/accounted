/**
 * Natural keys for event_log rows that more than one writer can produce
 * (event_log.dedupe_key, unique; migration 20261016001100).
 *
 * journal_entry.committed is written by the commit_journal_entry RPC inside
 * the transaction that posts the verifikat, and again by the event-bus
 * handler after the emit. Both use the key below, so the handler's write is
 * a no-op for an RPC-posted entry and still lands for an entry posted
 * another way (reverseEntry's storno posts by UPDATE).
 *
 * The SQL side builds the same string: 'journal_entry.committed:' || id.
 * Change both together; tests/pg/commit-journal-entry-event-outbox.pg.test.ts
 * fails when they drift. A leaf module (no imports) so that test can load it.
 */

/** Event types whose event_log row carries a dedupe_key. */
export const DEDUPED_EVENT_TYPES: ReadonlySet<string> = new Set(['journal_entry.committed'])

/** The row's natural key, or null when the type is not deduped or has no entity. */
export function eventDedupeKey(eventType: string, entityId: string | null): string | null {
  if (!entityId || !DEDUPED_EVENT_TYPES.has(eventType)) return null
  return `${eventType}:${entityId}`
}
