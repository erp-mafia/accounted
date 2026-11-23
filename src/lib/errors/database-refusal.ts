import { DOCUMENT_PERIOD_LOCK_REFUSAL } from './document-period-lock-refusal'

/**
 * Refusals the database raises as plain text (RAISE EXCEPTION with no code of
 * ours): the period-lock triggers (migration 017: a verifikat, and a document
 * on one), the company lock date, the locked period's tax adjustment and
 * tax depreciation election triggers, and the posting functions' own lock
 * checks. Every one of them is a lock. Triggers are never edited, so their
 * sentences are read here, once, for every door:
 * routes and services ask isPeriodLockRefusal/isLockDateRefusal
 * (lib/errors/get-structured-error.ts) instead of matching them, and
 * BookkeepingDatabaseError names its refusal by the code read here. A file of
 * its own so lib/bookkeeping/errors.ts can read it without importing the
 * module that imports it. Application code throws a code instead
 * (codedRefusal, userFacing): a sentence is never how the app tells a door
 * what failed.
 */
const DATABASE_REFUSALS: ReadonlyArray<{ pattern: RegExp; code: DatabaseRefusalCode; lockDate?: true }> = [
  // First: the generic pattern below matches the document trigger's text too.
  // A document refused on a locked year was a 500 on v1 upload and three
  // different sentences elsewhere; every door now answers this one code.
  { pattern: DOCUMENT_PERIOD_LOCK_REFUSAL, code: 'DOC_UPLOAD_PERIOD_LOCKED' },
  { pattern: /locked\/closed fiscal period/i, code: 'PERIOD_LOCKED' },
  { pattern: /Bokföringen är låst/, code: 'PERIOD_LOCKED', lockDate: true },
  { pattern: /Fiscal period is locked for tax (adjustments|depreciation elections)/i, code: 'PERIOD_LOCKED' },
  // The posting functions check the lock themselves before they commit, in
  // their own words, mostly under 23514: "Cannot <act> in a locked or closed
  // fiscal period" and "Bookkeeping is locked through <date>". The engine
  // carries the refusal of commit_asset_disposal,
  // commit_asset_component_replacement, commit_asset_value_adjustment,
  // commit_deferred_tax, commit_contract_revenue and commit_k3_transition to
  // the doors, met for example when the year is locked or the lock date moves
  // after the draft was inserted, and they answered it as a retryable 500.
  // split_asset_at_k3_transition and commit_opening_balance_replacement use
  // the same words; their callers answer or skip the refusal themselves.
  // lib/errors/__tests__/period-lock-refusal.test.ts reads every such
  // sentence from the migrations. Case-sensitive: the functions' own words.
  { pattern: /in a locked or closed fiscal period/, code: 'PERIOD_LOCKED' },
  { pattern: /Bookkeeping is locked through/, code: 'PERIOD_LOCKED', lockDate: true },
]

/** The registry code a lock refusal answers with. */
export type DatabaseRefusalCode = 'DOC_UPLOAD_PERIOD_LOCKED' | 'PERIOD_LOCKED'

/** The lock a database message refuses a write behind, or null when it is no lock refusal. */
export function databaseRefusal(message: string): { code: DatabaseRefusalCode; lockDate?: true } | null {
  return DATABASE_REFUSALS.find(({ pattern }) => pattern.test(message)) ?? null
}
