/**
 * Årsredovisning gate for scripts/undo-year-end-closing.ts.
 *
 * Reopening a closed year is only lawful while the annual report built on it
 * has no legal weight yet. What gives it weight, read from the schema:
 *
 *   - a signature: arsredovisning_signature_requests.status = 'signed' (the
 *     signed_atomic CHECK ties signed_at to that status; both are checked so
 *     a hand-edited row cannot slip through);
 *   - a signed or filed version: annual_report_versions.status in
 *     ('signed', 'filed', 'registered'). 'signed' is only reachable once
 *     every bound signer has signed (enforce_annual_report_version_
 *     immutability), 'filed'/'registered' need a Bolagsverket receipt;
 *   - any arsredovisning_submissions row. Submissions are never deleted or
 *     cancelled (they close via status), so any row at all means the report
 *     has entered the filing pipeline and a human must look first.
 *
 * Adoption at the årsstämma (fastställelse) is not recorded as a distinct
 * fact: arsredovisning_narratives.agm_date / agm_disposition_outcome are the
 * draft content of the fastställelseintyg, typed in before anyone signs. They
 * are surfaced as a warning so the operator confirms with the customer, but
 * they do not block on their own.
 *
 * What does NOT block: pending or declined signature requests and draft or
 * superseded versions. They are paperwork, not legal acts. A version still
 * 'ready_for_signature' is returned in versionsToSupersede: the caller
 * supersedes it (the same transition create_annual_report_version_with_
 * signatures makes when the report is re-finalized) so its pending slots can
 * no longer be signed against numbers the reopen is about to change
 * (enforce_annual_report_signature_version_state refuses a signature on a
 * version that is not ready_for_signature).
 */

export interface GateSubmission {
  id: string
  status: string
}

export interface GateSignatureRequest {
  id: string
  status: string
  signed_at: string | null
  annual_report_version_id: string | null
}

export interface GateVersion {
  id: string
  version_number: number
  status: string
}

export interface YearEndUndoGateInput {
  submissions: GateSubmission[]
  signatureRequests: GateSignatureRequest[]
  versions: GateVersion[]
  /** arsredovisning_narratives.agm_date for the period, if any. */
  agmDate: string | null
  /** Today as YYYY-MM-DD (Swedish local date). */
  today: string
}

export interface YearEndUndoGateResult {
  /** Non-empty means refuse the reopen. */
  blockers: string[]
  warnings: string[]
  /** ready_for_signature versions the reopen must supersede. */
  versionsToSupersede: GateVersion[]
  /** Pending requests bound to a version in versionsToSupersede. */
  voidedRequests: GateSignatureRequest[]
}

const LEGALLY_BINDING_VERSION_STATUSES = new Set(['signed', 'filed', 'registered'])

export function evaluateYearEndUndoGate(input: YearEndUndoGateInput): YearEndUndoGateResult {
  const blockers: string[] = []
  const warnings: string[] = []

  if (input.submissions.length > 0) {
    const statuses = [...new Set(input.submissions.map((s) => s.status))].join(', ')
    blockers.push(
      `an årsredovisning submission exists for this period (status: ${statuses}): refuse to reopen`
    )
  }

  const signed = input.signatureRequests.filter((r) => r.status === 'signed' || r.signed_at !== null)
  if (signed.length > 0) {
    blockers.push(
      `${signed.length} årsredovisning signature(s) already signed for this period: refuse to reopen`
    )
  }

  const binding = input.versions.filter((v) => LEGALLY_BINDING_VERSION_STATUSES.has(v.status))
  for (const v of binding) {
    blockers.push(`årsredovisning version ${v.version_number} is ${v.status}: refuse to reopen`)
  }

  const versionsToSupersede = input.versions.filter((v) => v.status === 'ready_for_signature')
  const supersededIds = new Set(versionsToSupersede.map((v) => v.id))

  const pending = input.signatureRequests.filter((r) => r.status === 'pending' && r.signed_at === null)
  const voidedRequests = pending.filter(
    (r) => r.annual_report_version_id !== null && supersededIds.has(r.annual_report_version_id)
  )
  const unbound = pending.filter((r) => r.annual_report_version_id === null)
  const declined = input.signatureRequests.filter((r) => r.status === 'declined')

  if (voidedRequests.length > 0) {
    warnings.push(
      `${voidedRequests.length} pending signature request(s) are bound to a version that will be ` +
        'superseded; they can no longer be signed and the next finalize prepares fresh slots'
    )
  }
  if (unbound.length > 0) {
    warnings.push(
      `${unbound.length} unbound pending signer slot(s) kept as the roster for the next finalize`
    )
  }
  if (declined.length > 0) {
    warnings.push(`${declined.length} declined signature request(s) kept as evidence`)
  }
  if (input.agmDate && input.agmDate <= input.today) {
    warnings.push(
      `an årsstämma date (${input.agmDate}) is recorded for this period: confirm with the customer ` +
        'that no stämma adopted the årsredovisning before reopening'
    )
  }

  return { blockers, warnings, versionsToSupersede, voidedRequests }
}
