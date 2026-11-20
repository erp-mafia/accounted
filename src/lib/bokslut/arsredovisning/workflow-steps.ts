/**
 * The årsredovisning as one numbered sequence of steps, derived from what is
 * actually stored: the fiscal year's closing, the compliance check, the
 * signer roster, the frozen versions and the AGM fields. Nothing here is
 * persisted and nothing here decides what the server allows; the page uses
 * it to show what is done, what is next and what blocks, and to give the
 * next step's button the one primary style on the page.
 *
 * Order follows the law's own sequence (swedish-financial-reporting):
 * the board and VD sign the årsredovisning (ÅRL 2 kap. 7 §), the årsstämma
 * then adopts the income statement and balance sheet and decides on the
 * result (the fastställelseintyg, ÅRL 8 kap. 3 §), and the årsredovisning
 * with the intyg reaches Bolagsverket within seven months of the year end.
 */
import type { AnnualReportComplianceIssue, AnnualReportVersionSummary } from './compliance-types'
import type { SignatureRequest } from './signature-service'

export const ANNUAL_REPORT_STEP_KEYS = [
  'bokslut',
  'scope',
  'content',
  'board',
  'lock',
  'signatures',
  'agm',
  'filing',
] as const

export type AnnualReportStepKey = (typeof ANNUAL_REPORT_STEP_KEYS)[number]

/** The one thing the user should do next; each maps to one button or link. */
export const ANNUAL_REPORT_NEXT_ACTIONS = [
  'close_year',
  'save_scope',
  'fix_company',
  'save_text',
  'fix_content',
  'confirm_content',
  'add_signer',
  'confirm_roster',
  'fix_blockers',
  'k3_draft_only',
  'lock_version',
  'register_signatures',
  'save_agm',
  'record_agm',
  'file',
] as const

export type AnnualReportNextAction = (typeof ANNUAL_REPORT_NEXT_ACTIONS)[number]

export type AnnualReportStepDetail =
  | { kind: 'none' }
  | { kind: 'done' }
  | { kind: 'errors'; count: number }
  | { kind: 'unsaved' }
  /** Only versionsutkast exist: a review copy, nothing to sign yet. */
  | { kind: 'draft'; number: number }
  | { kind: 'version'; number: number }
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'k3_draft_only' }

export interface AnnualReportStep {
  key: AnnualReportStepKey
  state: 'done' | 'current' | 'upcoming'
  detail: AnnualReportStepDetail
}

export interface AnnualReportWorkflow {
  steps: AnnualReportStep[]
  /** Null once every step is done. */
  next: { step: AnnualReportStepKey; action: AnnualReportNextAction } | null
}

export interface AnnualReportWorkflowInput {
  /** Closed here with a bokslut, or marked as closed in a previous program. */
  yearClosed: boolean
  /** The compliance check's issues (any severity; only errors count). */
  issues: ReadonlyArray<Pick<AnnualReportComplianceIssue, 'code' | 'severity' | 'section'>>
  signerRosterConfirmed: boolean
  /** Edits in the texts, disclosures and notes that are not saved yet. */
  unsavedContent: boolean
  /** Edits in the AGM fields that are not saved yet. */
  unsavedAgm: boolean
  signers: ReadonlyArray<Pick<SignatureRequest, 'status' | 'annual_report_version_id'>>
  versions: ReadonlyArray<Pick<AnnualReportVersionSummary, 'id' | 'version_number' | 'status'>>
  /** The saved AGM date and decision (see isAgmRecorded). */
  agmRecorded: boolean
}

/** Emitted for every K3 report: Accounted's K3 document cannot be locked yet. */
export const K3_DRAFT_ONLY_CODE = 'AR-K3-DRAFT-ONLY'
const CONTENT_CONFIRMATION_CODE = 'AR-MANAGEMENT-UNCONFIRMED'

const SIGNABLE_STATUSES: ReadonlyArray<AnnualReportVersionSummary['status']> = [
  'ready_for_signature',
  'signed',
  'filed',
  'registered',
]
const SIGNED_STATUSES: ReadonlyArray<AnnualReportVersionSummary['status']> = ['signed', 'filed', 'registered']
const FILED_STATUSES: ReadonlyArray<AnnualReportVersionSummary['status']> = ['filed', 'registered']

const SCOPE_SECTIONS: ReadonlyArray<AnnualReportComplianceIssue['section']> = ['scope', 'company']
const CONTENT_SECTIONS: ReadonlyArray<AnnualReportComplianceIssue['section']> = [
  'management_report',
  'notes',
  'statements',
]
/** Signing-stage issues (after a refused lock) belong to the board step. */
const BOARD_SECTIONS: ReadonlyArray<AnnualReportComplianceIssue['section']> = ['signatures']

/** Which step an issue is fixed in; issues of other sections block the lock. */
export function stepForIssue(
  issue: Pick<AnnualReportComplianceIssue, 'code' | 'section'>,
): AnnualReportStepKey {
  if (issue.code === K3_DRAFT_ONLY_CODE) return 'lock'
  if (SCOPE_SECTIONS.includes(issue.section)) return 'scope'
  if (CONTENT_SECTIONS.includes(issue.section)) return 'content'
  if (BOARD_SECTIONS.includes(issue.section)) return 'board'
  return 'lock'
}

/**
 * The AGM is recorded once its date and its decision on the result are
 * saved; an alternative decision needs its text. These are the fields the
 * fastställelseintyg prints.
 */
export function isAgmRecorded(fields: {
  agm_date: string | null | undefined
  agm_disposition_outcome: string | null | undefined
  agm_disposition_decision: string | null | undefined
}): boolean {
  if (!fields.agm_date?.trim() || !fields.agm_disposition_outcome) return false
  if (fields.agm_disposition_outcome === 'alternative_decision') {
    return Boolean(fields.agm_disposition_decision?.trim())
  }
  return true
}

interface Evaluated {
  done: boolean
  detail: AnnualReportStepDetail
  action: AnnualReportNextAction
}

export function deriveAnnualReportWorkflow(input: AnnualReportWorkflowInput): AnnualReportWorkflow {
  const errors = input.issues.filter((issue) => issue.severity === 'error')
  const errorsFor = (step: AnnualReportStepKey) => errors.filter((issue) => stepForIssue(issue) === step)

  // The newest version that is (or was) meant to be signed. A superseded one
  // was replaced by a later lock and no longer counts.
  const signable = input.versions
    .filter((version) => SIGNABLE_STATUSES.includes(version.status))
    .sort((left, right) => right.version_number - left.version_number)[0]
  const newestDraft = input.versions
    .filter((version) => version.status === 'draft')
    .sort((left, right) => right.version_number - left.version_number)[0]

  // Once a version is locked, scope, content and board are frozen in it:
  // later saves (the AGM date among them) clear the live confirmations but
  // do not undo what was locked.
  const locked = Boolean(signable)

  const bokslut: Evaluated = {
    done: input.yearClosed,
    detail: input.yearClosed ? { kind: 'done' } : { kind: 'none' },
    action: 'close_year',
  }

  const scopeErrors = errorsFor('scope')
  const scope: Evaluated =
    locked || scopeErrors.length === 0
      ? { done: true, detail: { kind: 'done' }, action: 'save_scope' }
      : {
          done: false,
          detail: { kind: 'errors', count: scopeErrors.length },
          // Scope questions (and the K2 assessment) are settled by saving
          // the assessment; company data (org.nr, säte) lives in settings.
          action: scopeErrors.some((issue) => issue.section === 'scope') ? 'save_scope' : 'fix_company',
        }

  const contentErrors = errorsFor('content')
  const content: Evaluated = input.unsavedContent
    ? { done: false, detail: { kind: 'unsaved' }, action: 'save_text' }
    : locked || contentErrors.length === 0
      ? { done: true, detail: { kind: 'done' }, action: 'confirm_content' }
      : contentErrors.every((issue) => issue.code === CONTENT_CONFIRMATION_CODE)
        ? { done: false, detail: { kind: 'none' }, action: 'confirm_content' }
        : { done: false, detail: { kind: 'errors', count: contentErrors.length }, action: 'fix_content' }

  const activeSigners = input.signers.filter((signer) => signer.status !== 'declined')
  const board: Evaluated = locked
    ? { done: true, detail: { kind: 'done' }, action: 'confirm_roster' }
    : activeSigners.length === 0
      ? { done: false, detail: { kind: 'none' }, action: 'add_signer' }
      : !input.signerRosterConfirmed
        ? { done: false, detail: { kind: 'none' }, action: 'confirm_roster' }
        : { done: true, detail: { kind: 'done' }, action: 'confirm_roster' }

  const lockErrors = errorsFor('lock')
  const lock: Evaluated = signable
    ? { done: true, detail: { kind: 'version', number: signable.version_number }, action: 'lock_version' }
    : lockErrors.some((issue) => issue.code === K3_DRAFT_ONLY_CODE)
      ? { done: false, detail: { kind: 'k3_draft_only' }, action: 'k3_draft_only' }
      : lockErrors.length > 0
        ? { done: false, detail: { kind: 'errors', count: lockErrors.length }, action: 'fix_blockers' }
        : {
            done: false,
            detail: newestDraft ? { kind: 'draft', number: newestDraft.version_number } : { kind: 'none' },
            action: 'lock_version',
          }

  const boundSigners = signable
    ? input.signers.filter((signer) => signer.annual_report_version_id === signable.id)
    : []
  const signed = Boolean(signable && SIGNED_STATUSES.includes(signable.status))
  const signatures: Evaluated = signed
    ? { done: true, detail: { kind: 'done' }, action: 'register_signatures' }
    : {
        done: false,
        detail:
          boundSigners.length > 0
            ? {
                kind: 'progress',
                done: boundSigners.filter((signer) => signer.status === 'signed').length,
                total: boundSigners.length,
              }
            : { kind: 'none' },
        action: 'register_signatures',
      }

  const agm: Evaluated = input.unsavedAgm
    ? { done: false, detail: { kind: 'unsaved' }, action: 'save_agm' }
    : input.agmRecorded
      ? { done: true, detail: { kind: 'done' }, action: 'record_agm' }
      : { done: false, detail: { kind: 'none' }, action: 'record_agm' }

  const filed = Boolean(signable && FILED_STATUSES.includes(signable.status))
  const filing: Evaluated = {
    done: filed,
    detail: filed ? { kind: 'done' } : { kind: 'none' },
    action: 'file',
  }

  const evaluated: Record<AnnualReportStepKey, Evaluated> = {
    bokslut,
    scope,
    content,
    board,
    lock,
    signatures,
    agm,
    filing,
  }

  // Unsaved edits come first: anything else would leave them behind.
  const firstOpen = ANNUAL_REPORT_STEP_KEYS.find((key) => !evaluated[key].done)
  const nextStep: AnnualReportStepKey | undefined = input.unsavedContent
    ? 'content'
    : input.unsavedAgm
      ? 'agm'
      : firstOpen
  const next = nextStep ? { step: nextStep, action: evaluated[nextStep].action } : null

  return {
    steps: ANNUAL_REPORT_STEP_KEYS.map((key) => ({
      key,
      state: key === next?.step ? 'current' : evaluated[key].done ? 'done' : 'upcoming',
      detail: evaluated[key].detail,
    })),
    next,
  }
}
