import type { CollectionsAction, CollectionsDecisionKind } from '@accounted/connect-contract'
import type { CollectionCaseView } from './case'
import { bankCheckState, type BankCheckState } from './handover-dialog'
import type { CaseEscalationCheckView } from './invoice-collection'
import { BANK_CHECKED_ACTIONS, MESSAGE_REQUIRED_ACTIONS, MIN_ACTION_MESSAGE, pauseUntilWindow } from './stages'

/**
 * The case card's decisions (build spec 3.5), pure and client-safe: which
 * buttons an open case shows, what each action's confirm dialog says and
 * asks for, whether an escalation may go ahead after the click-time check,
 * and the request the confirm sends. The card renders; the service decides
 * again at commit.
 */

/** Actions confirmed in the card's own dialog. `start` opens the handover dialog; `already_paid` the payment dialog. */
export type CardDialogAction = Exclude<CollectionsAction, 'start' | 'already_paid'>

export type CardButton =
  | { kind: 'handover'; action: 'start'; labelKey: string; primary: true }
  | { kind: 'payment'; action: 'already_paid'; labelKey: string; primary: false }
  | { kind: 'dialog'; action: CardDialogAction; labelKey: string; primary: boolean }

/** The order the card shows its buttons in: the decision the provider waits for first, then the rest. */
const BUTTON_ORDER: readonly CollectionsAction[] = [
  'start',
  'approve_step',
  'approve_legal_action',
  'decline_legal_action',
  'already_paid',
  'confirm_not_paid',
  'contest_dispute',
  'resume',
  'dispute',
  'pause',
  'withdraw',
]

const BUTTON_KEYS: Record<CollectionsAction, string> = {
  start: 'action_start',
  approve_step: 'action_approve',
  approve_legal_action: 'action_approve_legal',
  decline_legal_action: 'action_decline_legal',
  already_paid: 'action_already_paid',
  confirm_not_paid: 'action_confirm_not_paid',
  contest_dispute: 'action_contest_dispute',
  resume: 'action_resume',
  dispute: 'action_dispute',
  pause: 'action_pause',
  withdraw: 'action_withdraw',
}

const PRIMARY_ACTIONS: ReadonlySet<CollectionsAction> = new Set(['start', 'approve_step', 'approve_legal_action'])

/**
 * The buttons of an open, registered case: only the actions the provider's
 * last snapshot offers. None for a person who may not write, a case being
 * registered, or a closed case.
 */
export function caseCardButtons(
  view: Pick<CollectionCaseView, 'actions' | 'isOpen' | 'submissionStatus'>,
  canWrite: boolean,
): CardButton[] {
  if (!canWrite || !view.isOpen || view.submissionStatus !== 'registered') return []
  const offered = new Set(view.actions)
  return BUTTON_ORDER.filter((action) => offered.has(action)).map((action): CardButton => {
    if (action === 'start') return { kind: 'handover', action, labelKey: BUTTON_KEYS[action], primary: true }
    if (action === 'already_paid') return { kind: 'payment', action, labelKey: BUTTON_KEYS[action], primary: false }
    return { kind: 'dialog', action, labelKey: BUTTON_KEYS[action], primary: PRIMARY_ACTIONS.has(action) }
  })
}

/** What an action's confirm dialog says and asks for (keys in the collections namespace). */
export interface ActionDialogSpec {
  titleKey: string
  bodyKeys: string[]
  confirmKey: string
  destructive: boolean
  /** A written reason is required (at least MIN_ACTION_MESSAGE characters); labelKey null = the body asks for it. */
  message: { labelKey: string | null; min: number } | null
  /** Pause: the optional "until" date. */
  until: boolean
  /** The invoice is checked against the books and the bank when the dialog opens, and again at commit. */
  escalation: boolean
  /** Withdraw after the provider's free days: the fee line is shown and confirming acknowledges it. */
  feeLine: boolean
}

export function actionDialogSpec(
  action: CardDialogAction,
  context: { decisionKind: CollectionsDecisionKind | null; withdrawFeeMayApply: boolean },
): ActionDialogSpec {
  const base = {
    destructive: false,
    message: MESSAGE_REQUIRED_ACTIONS.has(action)
      ? { labelKey: action === 'dispute' ? 'dispute_field' : null, min: MIN_ACTION_MESSAGE }
      : null,
    until: action === 'pause',
    escalation: BANK_CHECKED_ACTIONS.has(action),
    feeLine: false,
  }
  switch (action) {
    case 'approve_step': {
      const reminder = context.decisionKind === 'approve_reminder'
      return {
        ...base,
        titleKey: reminder ? 'approve_reminder_title' : 'approve_notice_title',
        bodyKeys: reminder ? ['approve_body'] : ['approve_body', 'approve_notice_fee'],
        confirmKey: 'action_approve',
      }
    }
    case 'approve_legal_action':
      return { ...base, titleKey: 'legal_approve_title', bodyKeys: ['legal_approve_body'], confirmKey: 'action_approve_legal' }
    case 'decline_legal_action':
      return { ...base, titleKey: 'legal_decline_title', bodyKeys: ['legal_decline_body'], confirmKey: 'action_decline_legal' }
    case 'confirm_not_paid':
      return { ...base, titleKey: 'confirm_not_paid_title', bodyKeys: ['confirm_not_paid_body'], confirmKey: 'confirm_not_paid_confirm' }
    case 'contest_dispute':
      return { ...base, titleKey: 'contest_title', bodyKeys: ['contest_body'], confirmKey: 'contest_confirm' }
    case 'resume':
      return { ...base, titleKey: 'resume_title', bodyKeys: ['resume_body'], confirmKey: 'action_resume' }
    case 'dispute':
      return { ...base, titleKey: 'dispute_title', bodyKeys: ['dispute_body'], confirmKey: 'action_dispute' }
    case 'pause':
      return { ...base, titleKey: 'pause_title', bodyKeys: ['pause_body'], confirmKey: 'action_pause' }
    case 'withdraw':
      return {
        ...base,
        titleKey: 'withdraw_title',
        bodyKeys: context.withdrawFeeMayApply ? ['withdraw_body', 'withdraw_fee'] : ['withdraw_body'],
        confirmKey: 'withdraw_confirm',
        destructive: true,
        feeLine: context.withdrawFeeMayApply,
      }
  }
}

/** Whether a written reason is long enough (trimmed). */
export function messageLongEnough(spec: Pick<ActionDialogSpec, 'message'>, message: string): boolean {
  return spec.message === null || message.trim().length >= spec.message.min
}

/** Why a pause date cannot be used; null when it is empty (pause until resumed) or inside the window. */
export function pauseUntilProblem(until: string, today: string): 'pause_until_after_today' | 'pause_until_too_far' | null {
  if (!until) return null
  const window = pauseUntilWindow(today)
  if (until < window.earliest) return 'pause_until_after_today'
  if (until > window.latest) return 'pause_until_too_far'
  return null
}

/**
 * Where an escalation stands after the click-time check (GET
 * ?readiness=1 on the open case), in the order the service refuses:
 * the books say it is paid, the books hold a payment the provider has not
 * heard of, an unbooked bank row may be the payment, the bank is not fresh
 * (a person attests). `loading` until the check answers; `unavailable` when
 * it could not be read (the commit checks anyway).
 */
export type EscalationGate =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ok'; bank: BankCheckState }
  | { state: 'paid' }
  | { state: 'not_reported'; remaining: number; providerOutstanding: number }
  | { state: 'candidates'; bank: BankCheckState }
  | { state: 'attest'; bank: BankCheckState }

export function escalationGate(
  escalation: CaseEscalationCheckView | null | undefined,
  dismissed: readonly string[],
): EscalationGate {
  if (escalation === undefined) return { state: 'loading' }
  if (escalation === null) return { state: 'unavailable' }
  if (escalation.refusal?.code === 'COLLECTION_NOT_ELIGIBLE' || escalation.remaining <= 0) return { state: 'paid' }
  if (escalation.providerOutstanding !== null && escalation.remaining < escalation.providerOutstanding) {
    return { state: 'not_reported', remaining: escalation.remaining, providerOutstanding: escalation.providerOutstanding }
  }
  const bank = bankCheckState(escalation.bankCheck, dismissed)
  if (bank.outcome === 'candidates') return { state: 'candidates', bank }
  if (bank.needsAttest) return { state: 'attest', bank }
  return { state: 'ok', bank }
}

/** Whether the escalation's confirm may be pressed. */
export function escalationAllows(gate: EscalationGate, bankAttested: boolean): boolean {
  switch (gate.state) {
    case 'ok':
    case 'unavailable':
      return true
    case 'attest':
      return bankAttested
    default:
      return false
  }
}

/** POST /api/invoices/[id]/collection/actions. */
export interface CaseActionBody {
  action: CollectionsAction
  step?: 'reminder' | 'collection' | null
  message?: string | null
  until?: string | null
  bank_attested?: boolean
  dismissed_transaction_ids?: string[]
  fee_acknowledged?: boolean
}

export interface CaseActionAnswers {
  message: string
  until: string
  bankAttested: boolean
  dismissed: readonly string[]
  /** The fee line was on screen when the person confirmed. */
  feeShown: boolean
}

/**
 * The action request. The bank attestation and the dismissed rows go only
 * with an escalation (the only actions the service checks against the
 * bank); the fee acknowledgement only with a withdraw whose fee line was
 * shown.
 */
export function caseActionBody(action: CardDialogAction, spec: ActionDialogSpec, answers: CaseActionAnswers): CaseActionBody {
  const message = answers.message.trim()
  return {
    action,
    ...(message ? { message } : {}),
    ...(spec.until && answers.until ? { until: answers.until } : {}),
    ...(spec.escalation && answers.bankAttested ? { bank_attested: true } : {}),
    ...(spec.escalation && answers.dismissed.length > 0 ? { dismissed_transaction_ids: [...answers.dismissed] } : {}),
    ...(action === 'withdraw' && answers.feeShown ? { fee_acknowledged: true } : {}),
  }
}

/**
 * The one-line notes the card shows under the stage, in order: a claim the
 * provider holds but has not started (nothing reached the customer), an
 * invoice that is paid while the provider still has the case open (it
 * closes it; the card keeps syncing), and a case the bank sweep paused.
 */
export type CaseNote =
  | 'card_not_started'
  | 'card_paid_closing'
  | 'card_paused_possible_payment'
  | 'card_paused_possible_payment_answered'
  | 'card_paused_mismatch'

export function caseNotes(
  view: Pick<CollectionCaseView, 'isOpen' | 'submissionStatus' | 'stage' | 'pausedBySweep' | 'pauseReason' | 'possiblePayments'>,
  invoiceStatus: string | null,
): CaseNote[] {
  if (!view.isOpen || view.submissionStatus !== 'registered') return []
  const notes: CaseNote[] = []
  if (invoiceStatus === 'paid') notes.push('card_paid_closing')
  else if (view.stage === 'registered') notes.push('card_not_started')
  if (view.pausedBySweep && view.pauseReason === 'outstanding_mismatch') notes.push('card_paused_mismatch')
  else if (view.pausedBySweep && invoiceStatus !== 'paid') {
    // Paused over a bank row: ask about it while it is open, then offer to resume.
    notes.push(view.possiblePayments.length > 0 ? 'card_paused_possible_payment' : 'card_paused_possible_payment_answered')
  }
  return notes
}
