import type { JournalEntry } from '@/types'

/**
 * What correctEntry (storno-service) does with one journal_entries column on
 * the rättelse, the verifikat that replaces the corrected one:
 *   carried:  copied from the corrected verifikat as it is
 *   written:  set by correctEntry (some values come from the original)
 *   database: generated for the new row by a column default, a trigger or
 *             commit_journal_entry when it posts the row
 *   left:     deliberately not carried, so the new row gets NULL or the
 *             column default; the reason is on the line
 */
export type CorrectionColumnPolicy = 'carried' | 'written' | 'database' | 'left'

/** JournalEntry fields that are table columns (not relations or RPC extras). */
type JournalEntryColumn = Exclude<keyof JournalEntry, 'lines' | 'out_of_period'>

/**
 * Every journal_entries column, and what the rättelse does with it.
 *
 * A rättelse is the same affärshändelse booked right, so what the user said
 * about the event follows it. The header used to be built by listing the
 * columns to copy, so a column nobody listed was dropped without anyone
 * deciding it: the note (anteckning) was lost on every correction that way
 * (crm#1078). Here each column is carried or left behind on purpose.
 *
 * Copying the original row and removing a few columns would fail the other
 * way: import identity, commit provenance and the bank booking context
 * describe the ORIGINAL verifikat and must not follow.
 *
 * Three guards keep the table complete:
 *   - the `satisfies` below fails the typecheck when JournalEntry gains a
 *     field that is not listed;
 *   - storno-service.test.ts fails when correctEntry's insert and this table
 *     disagree: the insert names its columns one by one (so the phantom
 *     column guard can read them), and the test holds that list against the
 *     written and carried columns here;
 *   - correction-column-policy.pg.test.ts fails when the real table has a
 *     column that is not listed (the type lags the schema).
 *
 * The storno is not in this table: it is not the affärshändelse but its
 * cancellation, so it carries nothing the user said about the event. Its
 * text names the verifikat it reverses, and the original keeps its own note.
 */
export const CORRECTION_COLUMN_POLICY = {
  // What the user said about the affärshändelse.
  notes: 'carried',

  // The new verifikat itself.
  company_id: 'written',
  user_id: 'written', // who made the correction, not who booked the original
  fiscal_period_id: 'written', // the original's, unless the correction moves it (recordateEntry)
  voucher_number: 'written', // 0 on the draft; commit_journal_entry draws the next number in the series
  voucher_series: 'written', // the original's series
  entry_date: 'written', // the original's, unless the correction moves it
  description: 'written', // the caller's text, else "Rättelse: <original>"
  source_type: 'written', // always 'correction'
  correction_of_id: 'written', // the link back to the corrected verifikat
  status: 'written', // draft, then posted

  id: 'database',
  created_at: 'database',
  updated_at: 'database',
  committed_at: 'database', // set_committed_at, when this verifikat is posted
  committed_by: 'database', // stamp_journal_entry_committed_by
  // WHO and HOW of THIS commit, never the original's: commit_journal_entry
  // stamps them from the correcting actor (commitStornoOrCorrectionDraft).
  commit_method: 'database', // derived from that actor (defaultCommitMethod)
  committed_actor_type: 'database', // the user, key, OAuth client or cron job correcting
  committed_actor_label: 'database',

  reverses_id: 'left', // only a storno reverses
  reversed_by_id: 'left', // each verifikat's own link to its storno
  source_id: 'left', // polymorphic on source_type, which is 'correction' here; readers follow correction_of_id (DECISIONS 2026-09-06)
  attachment_urls: 'left', // legacy column nothing writes; underlag moves through relink_documents_to_correction
  rubric_version: 'left', // categorisation provenance of the original booking
  source_voucher_series: 'left', // the imported voucher's identity in its source system
  source_voucher_number: 'left',
  created_via: 'left', // how the ORIGINAL was created; nothing has written it since the AI subsystem was removed
  source_proposal_id: 'left', // remnant of the removed AI subsystem
  import_batch_id: 'left', // SIE import identity: a copy would put the correction inside the import batch
  source_ordinal: 'left',
  source_content_hash: 'left',
  bank_booking_context: 'left', // the bank rows the ORIGINAL lines were built from, revalidated when a verifikat is posted; the rows themselves follow through relinkTransactionsToEntry
} as const satisfies Record<JournalEntryColumn, CorrectionColumnPolicy> &
  Record<string, CorrectionColumnPolicy>
