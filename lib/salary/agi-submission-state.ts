/**
 * Derived AGI filing state for a salary run.
 *
 * Combines the run row's authoritative timestamps (agi_generated_at,
 * agi_submitted_at) with the Skatteverket extension's per-period submission
 * record (extension_data key `agi_submission_{period}`, surfaced via
 * GET /api/extensions/ext/skatteverket/agi/status).
 *
 * The submission record is optional: self-hosted installs without the
 * Skatteverket extension, users without the capability, and periods that
 * were never submitted have none. The derivation then falls back to what
 * the run row alone can tell ('none' | 'generated' | 'signed').
 */

/**
 * Per-period submission state mirrored in extension_data under
 * `agi_submission_{period}`. Matches the status enum the Skatteverket
 * extension handlers write back.
 */
export interface AgiSubmissionState {
  status?:
    | 'underlag_submitted' // POST /underlag returned an inlamningId
    | 'underlag_rejected' // kontrollresultat surfaced stoppande fel
    | 'awaiting_signing' // skapaGranskningsunderlag returned a link
    | 'signed' // kvittenser shows uuidKvittens for the period
  signeringslank?: string
  kvittensnummer?: string
  signeradAv?: string
  signeradTid?: string
  inlamningId?: number
  tillstand?: string
  meddelande?: string
  /** ISO timestamp the submission record was last written by the extension. */
  updatedAt?: string
}

export type AgiFilingState =
  | 'none'
  | 'generated'
  | 'underlag_submitted'
  | 'awaiting_signing'
  | 'signed'

export function deriveAgiFilingState(
  run: { agi_generated_at?: string | null; agi_submitted_at?: string | null },
  submission: AgiSubmissionState | null | undefined,
): AgiFilingState {
  // agi_submitted_at is stamped when a kvittens is observed (the canonical
  // filing receipt), so it is authoritative over the cached submission state.
  if (run.agi_submitted_at || submission?.status === 'signed') return 'signed'
  if (submission?.status === 'awaiting_signing') return 'awaiting_signing'
  if (submission?.status === 'underlag_submitted') return 'underlag_submitted'
  // underlag_rejected: the underlag at Skatteverket is dead; the user starts
  // over from the generated XML, so it renders the same as plain 'generated'.
  if (run.agi_generated_at) return 'generated'
  return 'none'
}
