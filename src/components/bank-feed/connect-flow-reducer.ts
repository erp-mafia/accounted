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
 * BankID step for the second signatory.
 */

import { initialSelection, setLedger, toggleAccount, type SelectionMap } from './account-selection'
import { firstStep, nextStep, type FlowMode, type FlowStep } from './flow-steps'
import type {
  AccountContext,
  ConnectMethod,
  ConnectionAttempt,
  ConnectionPoll,
  ConnectionPollState,
  ConnectionView,
  ConsentStep,
  CreateConnectionResult,
  PolledAccount,
} from './open-payments-client'

export interface FlowBank {
  bic: string
  name: string
}

export type VerificationStatus = 'valid' | 'invalid' | 'unknown'

export interface FlowState {
  mode: FlowMode
  step: FlowStep
  bank: FlowBank | null
  /** Prefilled from the connection being replaced: the person cannot pick another bank. */
  bankLocked: boolean
  affiliateId: string | null
  context: AccountContext | null
  method: ConnectMethod
  personalNumber: string
  replaceConnectionId: string | null
  connectionId: string | null
  /** The challenge on screen; null before the BankID starts. */
  attempt: ConnectionAttempt | null
  pollState: ConnectionPollState | null
  consentStep: ConsentStep | null
  /** The bank's steps this consent has been through: a second one means a new QR replaced a scanned one. */
  stepsSeen: ConsentStep[]
  failure: { code: string | null; text: string | null } | null
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
  /** The provider's form, once opened: the dialog then polls the status. */
  verificationUrl: string | null
}

export interface OpenFlowOptions {
  /** The bank of the connection being replaced (switch, renewal). */
  bank?: FlowBank | null
  /** The connection the new one takes over from (switch, renewal). */
  replaceConnectionId?: string | null
  /** The connection to resume at its BankID (second signatory). */
  connectionId?: string | null
}

export function openFlow(mode: FlowMode, options: OpenFlowOptions = {}): FlowState {
  const bank = options.bank ?? null
  return {
    mode,
    step: firstStep(mode),
    bank,
    bankLocked: bank !== null && (mode === 'switch' || mode === 'renew'),
    affiliateId: null,
    context: null,
    method: 'qr',
    personalNumber: '',
    replaceConnectionId: options.replaceConnectionId ?? null,
    connectionId: options.connectionId ?? null,
    attempt: null,
    pollState: null,
    consentStep: null,
    stepsSeen: [],
    failure: null,
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
    verificationUrl: null,
  }
}

export type FlowAction =
  | { type: 'continue' }
  | { type: 'bank_picked'; bank: FlowBank }
  /** A locked bank came from a connection row, which names the bank but not its BIC: the list resolves it. Null unlocks the list. */
  | { type: 'bank_resolved'; bic: string | null }
  | { type: 'affiliate_picked'; id: string | null }
  | { type: 'context_set'; context: AccountContext }
  | { type: 'to_bankid' }
  | { type: 'method_set'; method: ConnectMethod }
  | { type: 'personal_number_set'; value: string }
  | { type: 'start' }
  | { type: 'started'; result: CreateConnectionResult }
  | { type: 'start_failed'; message: string }
  | { type: 'polled'; poll: ConnectionPoll }
  | { type: 'account_toggled'; uid: string }
  | { type: 'ledger_set'; uid: string; ledger: string }
  | { type: 'activate' }
  /** `sync` is null when the first import did not finish in the request; `syncPending` says it runs on. */
  | { type: 'activated'; connection: ConnectionView; sync: { imported: number } | null; syncPending: boolean }
  | { type: 'second_consent'; attempt: ConnectionAttempt }
  | { type: 'activate_failed'; message: string }
  | { type: 'payments_offer'; offered: boolean; verification: VerificationStatus | null; validUntil: string | null }
  | { type: 'verification_opened'; url: string }
  | { type: 'verification_polled'; status: VerificationStatus; validUntil: string | null }
  | { type: 'payments_done' }

/** Whether the bank is still working on the consent: the poll keeps asking. */
export function pollingActive(state: FlowState): boolean {
  if (state.step !== 'bankid' || !state.connectionId) return false
  if (state.mode === 'resume' && state.attempt === null) return state.pollState !== 'failed' && state.pollState !== 'valid'
  return state.attempt !== null && (state.pollState === null || state.pollState === 'pending' || state.pollState === 'partially_authorised')
}

/** The screen after the accounts are live: the payments offer when it stands, else the finished screen. */
export function stepAfterActivation(state: Pick<FlowState, 'paymentsOffered' | 'verification'>): FlowStep {
  return state.paymentsOffered === true && state.verification !== 'valid' ? 'payments' : 'done'
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

function withStepSeen(seen: ConsentStep[], step: ConsentStep | null): ConsentStep[] {
  if (!step || seen.includes(step)) return seen
  return [...seen, step]
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'continue':
      return state.step === 'intro' ? { ...state, step: 'bank' } : state

    case 'bank_picked':
      if (state.bankLocked) return state
      return { ...state, bank: action.bank, affiliateId: null }

    case 'bank_resolved':
      if (!state.bank || state.bank.bic) return state
      if (action.bic === null) return { ...state, bank: null, bankLocked: false }
      return { ...state, bank: { ...state.bank, bic: action.bic } }

    case 'affiliate_picked':
      return { ...state, affiliateId: action.id }

    case 'context_set':
      return { ...state, context: action.context }

    case 'to_bankid':
      return state.bank?.bic ? { ...state, step: 'bankid', startError: null } : state

    case 'method_set':
      return { ...state, method: action.method }

    case 'personal_number_set':
      return { ...state, personalNumber: action.value }

    case 'start':
      return { ...state, starting: true, startError: null, failure: null, stepsSeen: [] }

    case 'started': {
      // A start can fail at once (the bank refused): the attempt says so with
      // the bank's text, and the step shows it with Försök igen.
      const { attempt } = action.result
      return {
        ...state,
        starting: false,
        startError: null,
        failure: attempt.state === 'failed' ? { code: attempt.failure_code, text: attempt.failure_text } : null,
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

    case 'account_toggled':
      return { ...state, selection: toggleAccount(state.selection, action.uid), activateError: null }

    case 'ledger_set':
      return { ...state, selection: setLedger(state.selection, action.uid, action.ledger), activateError: null }

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
        verification: action.verification,
        verificationUntil: action.validUntil,
      }

    case 'verification_opened':
      return { ...state, verificationUrl: action.url }

    case 'verification_polled':
      return { ...state, verification: action.status, verificationUntil: action.validUntil }

    case 'payments_done':
      return state.step === 'payments' ? { ...state, step: nextStep('payments', state.mode, state.paymentsOffered) ?? 'done' } : state

    default:
      return state
  }
}
