/**
 * The classifier's rule set has a version, and a model verdict carries the
 * version that made it (document_classifications.rules_version). When a rule
 * changes, bump the version here and say which types the change can move:
 * the classify cron then re-runs the model verdicts of those types made
 * under an older version, a bounded batch every run (requeueStaleVerdicts).
 *
 * Why: fixes used to be forward-only. The six supplier invoices under
 * Arcim's Kundfakturor (2026-09-27) were verdicts from the 21st, three rule
 * changes old, and nothing re-ran them; 569 documents in 58 companies sat
 * in the wrong invoice folder the same way.
 *
 * Rows written before the column exists have no version. For those, `since`
 * says when the rule for that type last changed: a verdict older than that
 * is stale, a newer one was made under the current rule and is left alone.
 */
export interface RuleChange {
  /** The types this change can move a document away from. */
  types: readonly string[]
  /** When the rule for these types last changed (ISO). Verdicts without a version from before this are stale. */
  since: string
}

export const CLASSIFY_RULES = {
  version: '2026-09-27',
  changed: [
    // The verifikat decides an invoice's direction (2026-09-27), the inbox reading before that (09-24).
    { types: ['customer_invoice'], since: '2026-09-27T09:03:00Z' },
    // A bill from an authority is a supplier invoice, not a decision (2026-09-25).
    { types: ['decision.skatteverket'], since: '2026-09-25T13:17:00Z' },
    // A credit note is never other; what a document is stays apart from whom it is addressed to (2026-09-26).
    { types: ['other'], since: '2026-09-26T13:00:00Z' },
  ] as readonly RuleChange[],
} as const

/** A model verdict the current rules might change: made under another version, or, unversioned, before the rule for its type last changed. */
export function isStaleVerdict(row: { doc_type: string; rules_version: string | null; created_at: string }, rules: typeof CLASSIFY_RULES = CLASSIFY_RULES): boolean {
  const change = rules.changed.find((c) => c.types.includes(row.doc_type))
  if (!change) return false
  if (row.rules_version != null) return row.rules_version !== rules.version
  return row.created_at < change.since
}
