/**
 * The state of one Koppla banken: which screen, which bank, where the bank's
 * BankID stands, which accounts go in, what the first sync brought, and
 * whether the payments verification is on offer. Pure, so the transitions
 * are tested without React; the dialog dispatches and renders.
 *
 * Three cases share it: a NEW connection, a SWITCH from an Enable Banking
 * connection (bank prefilled and locked; the server supersedes the old row
 * when the accounts are chosen) and a RENEWAL of an Open Payments connection
 * (same, without the intro). A RESUME opens an existing connection at the
 * BankID step: for the second signatory, or for the person coming back from
 * a bank that signs on its own page (`returned` says how that went).
 */

import { initialSelection, setLedger, toggleAccount, type SelectionMap } from './account-selection'
import type { VerificationState } from '@/lib/payments/orders/verification-state'
import { bankRequiresOffice, bankSigningApproach, type SigningApproach } from './bank-help'
import { dismissPolicy, firstStep, nextStep, type FlowMode, type FlowStep } from './flow-steps'
import type {
  AccountContext,
  ConnectMethod,
  ConnectionAttempt,
  ConnectionPoll,
  ConnectionPollState,
  ConnectionView,
  ConsentStep,
  CreateConnectionResult,
  OpenPaymentsBankDetails,
  PolledAccount,
} from './open-payments-client'
import type { PollGiveUpReason } from './poll-loop'

export interface FlowBank {
  bic: string
  name: string
  /** What the list says about signing there; the bank's details refine it. */
  decoupled?: boolean | null
  redirect?: boolean | null
}

/** The sparbank behind a shared BIC, chosen in the bank step. */
export interface FlowAffiliate {
  id: string
  name: string
}

/** How the person came back from the bank's own page: the URL's flag, never the outcome (polling decides). */
export interface FlowReturn {
  result: 'ok' | 'error'
  /** The bank's failure code on an error return. */
  code: string | null
}

export type VerificationStatus = 'valid' | 'invalid' | 'unknown'

/** The verification as the doors answer it (GET .../verification): the provider's status and the derived state. */
export interface VerificationView {
  status: VerificationStatus
  valid_until: string | null
  state: VerificationState
  /** ISO instant the current form link runs out; null without a link. */
  link_expires_at: string | null
}

export interface FlowState {
  mode: FlowMode
  step: FlowStep
  bank: FlowBank | null
  /** Prefilled from the connection being replaced: the person cannot pick another bank. */
  bankLocked: boolean
  /** The bank's details, once read for the chosen BIC: signing approach and sparbanker. */
  bankDetails: OpenPaymentsBankDetails | null
  /** The BIC whose details could not be read: the flow goes on with what the list said. */
  bankDetailsFailedBic: string | null
  affiliate: FlowAffiliate | null
  context: AccountContext | null
  method: ConnectMethod
  personalNumber: string
  /** Nordea Corporate Netbank's logon id, typed under the personnummer at Nordea only; '' for Nordea Business. Never stored. */
  psuAuthoriserId: string
  replaceConnectionId: string | null
  connectionId: string | null
  /** The challenge on screen; null before the BankID starts. */
  attempt: ConnectionAttempt | null
  pollState: ConnectionPollState | null
  consentStep: ConsentStep | null
  /** The bank's steps this consent has been through: a second one means a new QR replaced a scanned one. */
  stepsSeen: ConsentStep[]
  failure: { code: string | null; text: string | null } | null
  /**
   * The consent poll gave up (poll-loop.ts, crm#1355): the server refused it
   * (the connection is gone or no longer waits for a BankID) or nothing
   * answered for a while. The step says so instead of waiting forever, with
   * Börja om or Försök igen. Null while the poll runs or has not started.
   */
  pollError: { reason: PollGiveUpReason; text: string } | null
  /**
   * The person closed the flow over a running BankID (for #206): the consent
   * poll stops before the half-made connection is removed, and an answer
   * that was already on its way is dropped, so no poll is sent for (and no
   * give-up shown about) a connection we removed ourselves. Never unset: the
   * surface closes right after.
   */
  closing: boolean
  /** Set while the flow was reopened by a return from the bank's own page; cleared by the next start. */
  returned: FlowReturn | null
  starting: boolean
  startError: string | null
  accounts: PolledAccount[]
  selection: SelectionMap
  consentExpires: string | null
  /** Svea: the BankID on screen confirms the chosen accounts (round two). */
  secondConsent: boolean
  /** The second consent went through; the first sync runs next. */
  confirmed: boolean
  activating: boolean
  activateError: string | null
  /** What the first import brought, when it finished while the person waited. */
  firstSync: { imported: number } | null
  /** The first import runs on in the background (a long history, or a sync the bank asked us to wait with). */
  syncPending: boolean
  connection: ConnectionView | null
  /** Payments through the bank are available and not yet verified: the offer is shown. Null until known. */
  paymentsOffered: boolean | null
  verification: VerificationStatus | null
  verificationUntil: string | null
  /** Where the verification stands (lib/payments/orders/verification-state); null until the doors answered. */
  verificationState: VerificationState | null
  /** ISO instant the current form link runs out; null without a link. */
  verificationLinkExpiresAt: string | null
  /** The provider's form, once opened in this sitting: the dialog then polls the status and can open or copy it again. */
  verificationUrl: string | null
}

export interface OpenFlowOptions {
  /** The bank of the connection being replaced (switch, renewal). */
  bank?: FlowBank | null
  /** The connection the new one takes over from (switch, renewal). */
  replaceConnectionId?: string | null
  /** The connection to resume at its BankID (second signatory, or a return from the bank's page). */
  connectionId?: string | null
  /** A return from the bank's own page: ok polls at once, error shows the bank's code with Försök igen. */
  returned?: FlowReturn | null
}

export function openFlow(mode: FlowMode, options: OpenFlowOptions = {}): FlowState {
  const bank = options.bank ?? null
  const returned = mode === 'resume' ? (options.returned ?? null) : null
  return {
    mode,
    step: firstStep(mode),
    bank,
    bankLocked: bank !== null && (mode === 'switch' || mode === 'renew'),
    bankDetails: null,
    bankDetailsFailedBic: null,
    affiliate: null,
    context: null,
    method: returned ? 'redirect' : 'qr',
    personalNumber: '',
    psuAuthoriserId: '',
    replaceConnectionId: options.replaceConnectionId ?? null,
    connectionId: options.connectionId ?? null,
    attempt: null,
    // An error return is a failed attempt: nothing to poll, Försök igen starts anew.
    pollState: returned?.result === 'error' ? 'failed' : null,
    consentStep: null,
    stepsSeen: [],
    failure: returned?.result === 'error' ? { code: returned.code, text: null } : null,
    pollError: null,
    closing: false,
    returned,
    starting: false,
    startError: null,
    accounts: [],
    selection: {},
    consentExpires: null,
    secondConsent: false,
    confirmed: false,
    activating: false,
    activateError: null,
    firstSync: null,
    syncPending: false,
    connection: null,
    paymentsOffered: null,
    verification: null,
    verificationUntil: null,
    verificationState: null,
    verificationLinkExpiresAt: null,
    verificationUrl: null,
  }
}

export type FlowAction =
  | { type: 'continue' }
  | { type: 'bank_picked'; bank: FlowBank }
  /** A locked bank came from a connection row, which names the bank but not its BIC: the list resolves it. Null unlocks the list. */
  | { type: 'bank_resolved'; bic: string | null }
  /** The bank's details arrived for the chosen BIC (ignored for another bank). */
  | { type: 'bank_details_loaded'; details: OpenPaymentsBankDetails }
  /** The details of this BIC could not be read: nothing more to wait for. */
  | { type: 'bank_details_failed'; bic: string }
  | { type: 'affiliate_picked'; affiliate: FlowAffiliate | null }
  /** A resumed connection told us its bank (the row names it). */
  | { type: 'connection_known'; bank: FlowBank }
  | { type: 'context_set'; context: AccountContext }
  | { type: 'to_bankid' }
  | { type: 'method_set'; method: ConnectMethod }
  | { type: 'personal_number_set'; value: string }
  | { type: 'psu_authoriser_id_set'; value: string }
  | { type: 'start' }
  | { type: 'started'; result: CreateConnectionResult }
  | { type: 'start_failed'; message: string }
  | { type: 'polled'; poll: ConnectionPoll }
  /** The poll loop ended on a failure: `text` is the sentence the step shows. */
  | { type: 'poll_gave_up'; reason: PollGiveUpReason; text: string }
  /** Försök igen after nothing answered: the poll runs again on the same consent. */
  | { type: 'poll_retry' }
  /** Börja om after the poll was refused: back to the BankID start (a resumed connection: a new connection from the bank step). */
  | { type: 'start_over' }
  /** The person closes the flow: the poll stops now and late answers are dropped. */
  | { type: 'closing' }
  | { type: 'account_toggled'; uid: string }
  | { type: 'ledger_set'; uid: string; ledger: string }
  | { type: 'activate' }
  /** `sync` is null when the first import did not finish in the request; `syncPending` says it runs on. */
  | { type: 'activated'; connection: ConnectionView; sync: { imported: number } | null; syncPending: boolean }
  | { type: 'second_consent'; attempt: ConnectionAttempt }
  | { type: 'activate_failed'; message: string }
  | { type: 'payments_offer'; offered: boolean; verification: VerificationView | null }
  | { type: 'verification_opened'; url: string; expiresAt: string; state: VerificationState }
  | { type: 'verification_polled'; verification: VerificationView }
  | { type: 'payments_done' }

/** Whether the bank is still working on the consent: the poll keeps asking. */
export function pollingActive(state: FlowState): boolean {
  if (state.closing || state.step !== 'bankid' || !state.connectionId || state.pollError) return false
  if (state.mode === 'resume' && state.attempt === null) return state.pollState !== 'failed' && state.pollState !== 'valid'
  return state.attempt !== null && (state.pollState === null || state.pollState === 'pending' || state.pollState === 'partially_authorised')
}

/**
 * Whether the chosen bank's details have answered (or failed to): only then
 * is it known whether the bank has offices or sparbanker to choose among, so
 * Continue waits for it. A bank started before its picker showed goes out
 * without an office, which a bank that needs one always refuses (for #208).
 * A read that failed counts as settled: the flow goes on with what the list
 * said, as before.
 */
export function bankDetailsSettled(state: Pick<FlowState, 'bank' | 'bankDetails' | 'bankDetailsFailedBic'>): boolean {
  const bic = state.bank?.bic
  if (!bic) return false
  return state.bankDetails?.bic === bic || state.bankDetailsFailedBic === bic
}

/**
 * Whether the chosen bank still lacks the office it needs (bankRequiresOffice
 * in bank-help.ts): such a bank has no row of its own in the picker, so
 * Continue waits until one of its offices is chosen (for #158). Only while
 * its offices are on screen: details that failed or list none leave the flow
 * to go on with what the list said, as for any other bank.
 */
export function officeChoiceMissing(state: Pick<FlowState, 'bank' | 'bankDetails' | 'affiliate'>): boolean {
  if (!state.bank?.bic || !bankRequiresOffice(state.bank)) return false
  return state.affiliate === null && (state.bankDetails?.affiliates.length ?? 0) > 0
}

/**
 * Whether closing the flow removes its connection: a half-made one (a BankID
 * that was closed over, an unsaved selection) goes so no row lingers. A live
 * connection stays, and so does one resumed for the second signatory (it
 * belongs to the first); one the person came back to from the bank's page is
 * their own and goes.
 */
export function removesConnectionOnClose(state: Pick<FlowState, 'connectionId' | 'connection' | 'mode' | 'returned'>): boolean {
  return Boolean(state.connectionId) && !state.connection && (state.mode !== 'resume' || state.returned !== null)
}

/**
 * The bank has refused the consent (or the person came back from its page
 * with an error): nothing is running at the bank, and the step shows the
 * reason and what to do next.
 */
export function consentRefused(state: Pick<FlowState, 'pollState'>): boolean {
  return state.pollState === 'failed'
}

export type CloseOutcome = 'confirm' | 'remove' | 'close'

/**
 * What a request to close does where the flow stands: ask first (a BankID is
 * running, a selection is unsaved), close at once and remove the half-made
 * connection behind the close (the bank has refused: there is nothing to
 * interrupt, and the row must not linger), or just close.
 */
export function closeOutcome(state: Pick<FlowState, 'step' | 'pollState' | 'connectionId' | 'connection' | 'mode' | 'returned'>): CloseOutcome {
  if (dismissPolicy(state.step, consentRefused(state)) === 'confirm') return 'confirm'
  return removesConnectionOnClose(state) ? 'remove' : 'close'
}

/** The screen after the accounts are live: the payments offer when it stands, else the finished screen. */
export function stepAfterActivation(state: Pick<FlowState, 'paymentsOffered' | 'verification'>): FlowStep {
  return state.paymentsOffered === true && state.verification !== 'valid' ? 'payments' : 'done'
}

/** The bank as the person knows it: the sparbank when one is chosen, else the bank, else the connection's name. */
export function displayBankName(state: Pick<FlowState, 'affiliate' | 'bank' | 'connection'>): string | null {
  return state.affiliate?.name ?? state.bank?.name ?? state.connection?.bank_name ?? null
}

/** How the chosen bank signs: from its details once read, else from what the list said. */
export function signingApproach(state: Pick<FlowState, 'bank' | 'bankDetails'>): SigningApproach {
  if (state.bankDetails) return bankSigningApproach(state.bankDetails)
  return bankSigningApproach({ decoupled: state.bank?.decoupled ?? null, redirect: state.bank?.redirect ?? null })
}

/** The attempt in flight signs on the bank's own page. */
export function redirectInFlight(state: Pick<FlowState, 'method' | 'attempt'>): boolean {
  return state.method === 'redirect' || state.attempt?.method === 'redirect' || state.attempt?.challenge?.approach === 'redirect'
}

/**
 * A poll answers where the consent stands; some banks repeat the challenge
 * on every poll (the animated QR), others send it once at the start. A
 * pending poll without a challenge keeps the one on screen.
 */
function mergeChallenge(state: FlowState, poll: ConnectionPoll): ConnectionAttempt | null {
  const attemptState: ConnectionAttempt['state'] = poll.state === 'valid' ? 'pending' : poll.state
  if (!state.attempt) {
    return poll.challenge
      ? {
          authorisation_id: null,
          method: poll.method ?? state.method,
          state: attemptState,
          challenge: poll.challenge,
          sca_status: poll.sca_status,
          step: poll.step,
          failure_code: poll.failure_code,
          failure_text: poll.failure_text,
        }
      : null
  }
  return {
    ...state.attempt,
    state: attemptState,
    challenge: poll.challenge ?? (poll.state === 'pending' || poll.state === 'partially_authorised' ? state.attempt.challenge : null),
    sca_status: poll.sca_status,
    step: poll.step,
    failure_code: poll.failure_code,
    failure_text: poll.failure_text,
  }
}

/**
 * Börja om after a refused poll: the connection the flow waited on is gone or
 * no longer waits for a BankID, so nothing on it can be resumed. A new
 * connection, a switch and a renewal go back to the BankID start with the
 * bank and the typed numbers kept, and the next start makes a new
 * connection. A resumed connection has nothing of its own to start from: the
 * flow opens anew at the bank step, the bank preselected when it is known.
 * The payments offer, probed once at open, is kept either way.
 */
function startOver(state: FlowState): FlowState {
  const kept = {
    personalNumber: state.personalNumber,
    psuAuthoriserId: state.psuAuthoriserId,
    paymentsOffered: state.paymentsOffered,
    verification: state.verification,
    verificationUntil: state.verificationUntil,
    verificationState: state.verificationState,
    verificationLinkExpiresAt: state.verificationLinkExpiresAt,
    verificationUrl: state.verificationUrl,
  }
  if (state.mode === 'resume') return { ...openFlow('new', { bank: state.bank?.bic ? state.bank : null }), ...kept }
  return {
    ...state,
    ...kept,
    step: 'bankid',
    connectionId: null,
    attempt: null,
    pollState: null,
    consentStep: null,
    stepsSeen: [],
    failure: null,
    pollError: null,
    returned: null,
    starting: false,
    startError: null,
    secondConsent: false,
    confirmed: false,
    accounts: [],
    selection: {},
  }
}

function withStepSeen(seen: ConsentStep[], step: ConsentStep | null): ConsentStep[] {
  if (!step || seen.includes(step)) return seen
  return [...seen, step]
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'continue':
      return state.step === 'intro' ? { ...state, step: 'bank' } : state

    case 'bank_picked':
      if (state.bankLocked) return state
      return {
        ...state,
        bank: action.bank,
        affiliate: null,
        bankDetails: state.bankDetails?.bic === action.bank.bic ? state.bankDetails : null,
      }

    case 'bank_resolved':
      if (!state.bank || state.bank.bic) return state
      if (action.bic === null) return { ...state, bank: null, bankLocked: false }
      return { ...state, bank: { ...state.bank, bic: action.bic } }

    case 'bank_details_loaded': {
      if (!state.bank || action.details.bic !== state.bank.bic) return state
      // A locked bank named after its sparbank (a renewal) finds itself among the affiliates.
      const bankName = state.bank.name
      const affiliate = state.affiliate ?? action.details.affiliates.find((a) => sameName(a.name, bankName)) ?? null
      return { ...state, bankDetails: action.details, affiliate }
    }

    case 'bank_details_failed':
      return { ...state, bankDetailsFailedBic: action.bic }

    case 'affiliate_picked':
      return { ...state, affiliate: action.affiliate }

    case 'connection_known':
      return state.bank ? state : { ...state, bank: action.bank }

    case 'context_set':
      return { ...state, context: action.context }

    case 'to_bankid':
      return state.bank?.bic ? { ...state, step: 'bankid', startError: null } : state

    case 'method_set':
      return { ...state, method: action.method }

    case 'personal_number_set':
      return { ...state, personalNumber: action.value }

    case 'psu_authoriser_id_set':
      return { ...state, psuAuthoriserId: action.value }

    case 'start':
      return { ...state, starting: true, startError: null, failure: null, pollError: null, stepsSeen: [] }

    case 'started': {
      // A start can fail at once (the bank refused): the attempt says so with
      // the bank's text, and the step shows it with Försök igen.
      const { attempt } = action.result
      return {
        ...state,
        starting: false,
        startError: null,
        failure: attempt.state === 'failed' ? { code: attempt.failure_code, text: attempt.failure_text } : null,
        pollError: null,
        returned: null,
        connectionId: action.result.connection_id,
        attempt,
        method: attempt.method,
        pollState: attempt.state,
        consentStep: attempt.step,
        stepsSeen: withStepSeen([], attempt.step),
      }
    }

    case 'start_failed':
      return { ...state, starting: false, startError: action.message }

    case 'polled': {
      // An answer that was on its way when the person closed the flow.
      if (state.closing) return state
      const { poll } = action
      const attempt = mergeChallenge(state, poll)
      const base: FlowState = {
        ...state,
        attempt,
        pollState: poll.state,
        consentStep: poll.step,
        stepsSeen: withStepSeen(state.stepsSeen, poll.step),
        consentExpires: poll.consent_expires ?? state.consentExpires,
      }
      if (poll.state === 'failed') {
        return { ...base, failure: { code: poll.failure_code, text: poll.failure_text } }
      }
      if (poll.state === 'valid') {
        if (state.secondConsent) {
          // Svea's second round is through: the chosen accounts are confirmed and the first sync runs next.
          return { ...base, failure: null, confirmed: true }
        }
        const accounts = poll.accounts ?? []
        return { ...base, failure: null, accounts, selection: initialSelection(accounts), step: 'accounts', activateError: null }
      }
      return { ...base, failure: null }
    }

    case 'poll_gave_up':
      // A refusal about a connection the close itself removed is not news.
      if (state.closing) return state
      return { ...state, pollError: { reason: action.reason, text: action.text } }

    case 'poll_retry':
      return state.pollError?.reason === 'unreachable' ? { ...state, pollError: null } : state

    case 'start_over':
      return startOver(state)

    case 'closing':
      return state.closing ? state : { ...state, closing: true }

    case 'account_toggled':
      return { ...state, selection: toggleAccount(state.accounts, state.selection, action.uid), activateError: null }

    case 'ledger_set':
      return { ...state, selection: setLedger(state.accounts, state.selection, action.uid, action.ledger), activateError: null }

    case 'activate':
      return { ...state, activating: true, activateError: null }

    case 'activated':
      return {
        ...state,
        activating: false,
        confirmed: false,
        secondConsent: false,
        connection: action.connection,
        bank: state.bank ?? (action.connection.bank_name ? { bic: action.connection.bic ?? '', name: action.connection.bank_name } : null),
        consentExpires: action.connection.consent_expires ?? state.consentExpires,
        firstSync: action.sync,
        syncPending: action.syncPending,
        step: stepAfterActivation(state),
      }

    case 'second_consent':
      return {
        ...state,
        activating: false,
        secondConsent: true,
        confirmed: false,
        step: 'bankid',
        attempt: action.attempt,
        method: action.attempt.method,
        pollState: 'pending',
        consentStep: action.attempt.step,
        stepsSeen: withStepSeen([], action.attempt.step),
        failure: null,
      }

    case 'activate_failed':
      return { ...state, activating: false, activateError: action.message }

    case 'payments_offer':
      return {
        ...state,
        paymentsOffered: action.offered,
        verification: action.verification?.status ?? (action.offered ? 'unknown' : null),
        verificationUntil: action.verification?.valid_until ?? null,
        verificationState: action.verification?.state ?? null,
        verificationLinkExpiresAt: action.verification?.link_expires_at ?? null,
      }

    case 'verification_opened':
      return { ...state, verificationUrl: action.url, verificationLinkExpiresAt: action.expiresAt, verificationState: action.state }

    case 'verification_polled':
      return {
        ...state,
        verification: action.verification.status,
        verificationUntil: action.verification.valid_until,
        verificationState: action.verification.state,
        verificationLinkExpiresAt: action.verification.link_expires_at,
      }

    case 'payments_done':
      return state.step === 'payments' ? { ...state, step: nextStep('payments', state.mode, state.paymentsOffered) ?? 'done' } : state

    default:
      return state
  }
}
