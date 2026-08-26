/**
 * Derived AGI filing state for a salary run.
 *
 * Combines the run row's authoritative timestamps (agi_generated_at,
 * agi_submitted_at) with the Skatteverket extension's per-period submission
 * record (extension_data key `agi_submission_{period}`, surfaced via
 * GET /api/extensions/ext/skatteverket/agi/status; once the kvittens
 * reconciliation has deleted that cache the same route serves the receipt
 * recorded on `agi_declarations`, see `source`).
 *
 * The submission record is optional: self-hosted installs without the
 * Skatteverket extension, users without the capability, and periods that
 * were never submitted have none. The derivation then falls back to what
 * the run row alone can tell ('none' | 'generated' | 'signed').
 *
 * IMPORTANT: the submission record is keyed by PERIOD, but a period can hold
 * more than one salary run. `salary_runs` is unique per (company, period)
 * only for non-corrected runs (migration 20260414130000): correcting a booked
 * run flips the original to 'corrected' and inserts a correction run for the
 * same month, so the two share one `agi_submission_{period}` record.
 *
 * A correction is a full replacement declaration filed for the same
 * redovisningsperiod (same specifikationsnummer per employee) and it gets its
 * OWN kvittens from Skatteverket. Letting the correction run read the
 * original's record would render its AGI step as filed, showing a kvittens
 * that belongs to a declaration the correction supersedes. Everything below
 * therefore resolves the record against the run before trusting it.
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
  /**
   * The moment recorded as the filing time: Skatteverket's signeradTid, or
   * the reconciliation time when Skatteverket omitted it. Written by the
   * extension's status read from `agi_declarations.submitted_at`, the same
   * value that stamps `salary_runs.agi_submitted_at`.
   */
  submittedAt?: string
  /**
   * True when `submittedAt` is our reconciliation-time upper bound rather
   * than Skatteverket's signing moment (signeradTid absent), so the UI can
   * label it as an estimate instead of as the legal signing time.
   */
  submittedAtEstimated?: boolean
  /**
   * Where the record was read from: the in-flight `agi_submission_{period}`
   * cache, or the receipt on `agi_declarations` once the kvittens
   * reconciliation has deleted that cache (#1597).
   */
  source?: 'cache' | 'declaration'
  inlamningId?: number
  tillstand?: string
  meddelande?: string
  /**
   * Salary run whose XML was posted to /underlag. Written by the extension's
   * `/agi/submit` handler and by the MCP submit path; the later
   * `awaiting_signing` / `signed` writes do not carry it, which is why the
   * fallbacks in `resolveRunAgiSubmission` exist.
   */
  salaryRunId?: string
  /** ISO timestamp the submission record was last written by the extension. */
  updatedAt?: string
}

export type AgiFilingState =
  | 'none'
  | 'generated'
  | 'underlag_submitted'
  | 'awaiting_signing'
  | 'signed'

/** The run fields the derivation needs. `id` enables the exact-match path. */
export interface AgiFilingRun {
  id?: string | null
  agi_generated_at?: string | null
  agi_submitted_at?: string | null
}

/** Parse an ISO timestamp to epoch ms; null for missing or unparseable. */
function epoch(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Narrow the period-scoped submission record to the run it actually describes.
 *
 * Returns the record when it provably belongs to `run`, otherwise null so the
 * caller falls back to the run row's own timestamps. Three signals, strongest
 * first:
 *
 * 1. `salaryRunId` on the record: an exact match. The extension writes it when
 *    it posts the underlag, so the whole in-flight phase is unambiguous.
 * 2. `signeradTid` against `run.agi_submitted_at` for a signed record: the
 *    kvittens stamp on the run row is written from the same signeradTid, so an
 *    already-filed run only owns receipts whose signing moment matches. A newer
 *    signeradTid is the next declaration for the period (the correction's).
 * 3. `updatedAt` against `run.agi_generated_at`: a record written before this
 *    run produced its XML cannot describe this run's declaration. A run with no
 *    XML at all owns nothing.
 */
export function resolveRunAgiSubmission(
  run: AgiFilingRun,
  submission: AgiSubmissionState | null | undefined,
): AgiSubmissionState | null {
  if (!submission?.status) return null

  // 1. Exact match: only the run that posted the underlag owns this record.
  if (submission.salaryRunId) {
    return run.id && submission.salaryRunId === run.id ? submission : null
  }

  const generatedAt = epoch(run.agi_generated_at)
  const submittedAt = epoch(run.agi_submitted_at)
  const recordUpdatedAt = epoch(submission.updatedAt)

  // 2. This run already carries a kvittens stamp. Its own receipt is the one
  // whose signeradTid produced that stamp; a record signed at any other moment
  // belongs to another declaration for the same period. Skatteverket may omit
  // signeradTid: the record then carries the reconciliation-time stamp as
  // `submittedAt` (the same value written to the run row), and a record with
  // neither has nothing to contradict ownership.
  if (submission.status === 'signed' && submittedAt !== null) {
    const signeradTid = epoch(submission.signeradTid ?? submission.submittedAt)
    return signeradTid === null || signeradTid === submittedAt ? submission : null
  }

  // A filed run is terminal: any in-flight underlag for the period belongs to
  // a later run, never to this one.
  if (submittedAt !== null) return null

  // 3. No XML from this run means no declaration of its own at Skatteverket,
  // and a record older than this run's XML describes what the XML replaced.
  if (generatedAt === null) return null
  if (recordUpdatedAt !== null && recordUpdatedAt < generatedAt) return null

  return submission
}

export function deriveAgiFilingState(
  run: AgiFilingRun,
  submission: AgiSubmissionState | null | undefined,
): AgiFilingState {
  // Only the record that provably belongs to this run may advance its state:
  // the period-scoped record can be a sibling run's.
  const own = resolveRunAgiSubmission(run, submission)

  // agi_submitted_at is stamped when a kvittens is observed (the canonical
  // filing receipt), so it is authoritative over the cached submission state.
  if (run.agi_submitted_at || own?.status === 'signed') return 'signed'
  if (own?.status === 'awaiting_signing') return 'awaiting_signing'
  if (own?.status === 'underlag_submitted') return 'underlag_submitted'
  // underlag_rejected: the underlag at Skatteverket is dead; the user starts
  // over from the generated XML, so it renders the same as plain 'generated'.
  if (run.agi_generated_at) return 'generated'
  return 'none'
}

/**
 * The kvittensnummer a run may display as its own filing receipt.
 *
 * Null unless the period record is both signed and provably this run's, so no
 * two runs in the same month can ever show the same kvittens. A run that filed
 * (agi_submitted_at set) but whose receipt has since been superseded in the
 * cache renders as filed without a number rather than with someone else's.
 */
export function resolveRunAgiKvittensnummer(
  run: AgiFilingRun,
  submission: AgiSubmissionState | null | undefined,
): string | null {
  const own = resolveRunAgiSubmission(run, submission)
  if (own?.status !== 'signed') return null
  return own.kvittensnummer ?? null
}
