'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { useQrCountdown } from '@/components/bankid/use-qr-countdown'
import { PaymentsClientError, type CompanyVerification, type StartedVerification } from '@/components/payments/payments-client'
import { FORM_OUT_STATES } from '@/lib/payments/orders/verification-state'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { resolveBankByName, type SigningApproach } from './bank-help'
import { displayBankName, flowReducer, openFlow, pollingActive, redirectInFlight, signingApproach, type FlowAction, type FlowState } from './connect-flow-reducer'
import {
  isBankBusy,
  isSecondConsent,
  isSyncCooldown,
  OpenPaymentsClientError,
  type ConnectMethod,
  type ConnectionView,
  type CreateConnectionResult,
  type OpenPaymentsApi,
  type OpenPaymentsBank,
  type OpenPaymentsBankDetails,
  type SignerInput,
} from './open-payments-client'
import { normalizePersonalNumber } from './personal-number'
import { startPollLoop } from './poll-loop'
import { selectionPayload } from './account-selection'
import type { BankConnectSession } from './use-bank-connect-flow'

/** How often the consent is asked about while the bank's BankID runs: the animated QR changes every second. */
const CONSENT_POLL_MS = 1000
/** A consent waiting for a second signatory changes rarely. */
const SECOND_SIGNER_POLL_MS = 5000
/** The provider's verification form is filled in by hand: a quarter minute between looks. */
const VERIFICATION_POLL_MS = 15_000
/** A phone: where BankID on this device is the natural way, and the bank's own page is offered beside it. */
const MOBILE_QUERY = '(max-width: 639px)'

/** Whether the payments offer stands at open: available to the company and not yet verified. */
export interface PaymentsOffer {
  offered: boolean
  /** The doors' answer, when they gave one; null when the offer stands with an unknown status (a provider hiccup). */
  verification: CompanyVerification | null
}

/** How a verification form is started: opened here, mailed to a firmatecknare, or copied for one. The last two hand it off. */
export type VerificationStartKind = 'verify' | 'mail' | 'copy'

/**
 * The doors one Koppla banken talks through. The dialog binds them to the
 * session routes (the logged-in member of the active company); the signatory
 * page binds them to the token routes under /api/koppla/[token]. The flow is
 * the same either way.
 */
export interface BankConnectBackend {
  bank: OpenPaymentsApi
  /** Null: payments are never offered on this surface. */
  payments: {
    probe(): Promise<PaymentsOffer>
    fetchVerification(options?: { refresh?: boolean }): Promise<CompanyVerification>
    startVerification(options?: { handoff?: boolean }): Promise<StartedVerification>
  } | null
  /**
   * Whether the person signing has a personnummer on file (nothing to type).
   * `onAnswer` may be called more than once as better answers land; the
   * return value cleans up.
   */
  watchSignerKnown(onAnswer: (known: boolean) => void): () => void
  /**
   * The person is about to leave for the bank's own page. The surface may
   * keep what the page state alone would lose on the way back (the signatory
   * page keeps the typed personnummer for this connection).
   */
  beforeLeavingForBank?(connectionId: string, state: FlowState): void
}

export interface BankConnectControllerOptions {
  session: BankConnectSession
  backend: BankConnectBackend
  /** The banks, once known; a locked bank named by a connection row resolves its BIC here. */
  banks: OpenPaymentsBank[] | null
  banksFailed: boolean
  /** Called once per session when the connection is live (accounts chosen, first sync run, running on, or attempted). */
  onConnected?: (connection: ConnectionView, sync: { imported: number } | null) => void
}

export interface BankConnectController {
  state: FlowState
  dispatch: (action: FlowAction) => void
  signerKnown: boolean
  personalNumberInvalid: boolean
  paymentsBusy: VerificationStartKind | null
  /** The QR's 30 seconds, counted from the bank's step; null when no QR is on screen. */
  secondsLeft: number | null
  /** How the chosen bank signs: our screen, its own page, both, or neither. */
  approach: SigningApproach
  /** The attempt in flight, or the chosen bank, signs on the bank's own page: the help says so. */
  redirectHelp: boolean
  /** A phone-sized viewport: the only place the bank's page is offered next to BankID on this device. */
  mobile: boolean
  /** The bank as the person knows it: the sparbank when one is chosen, else the bank, else the connection's name. */
  bankName: string | null
  /** A failed call as a sentence in the person's language. */
  describe: (error: unknown, fallback: string) => string
  start: (method: ConnectMethod) => Promise<void>
  restart: (method?: ConnectMethod) => Promise<void>
  /** The second signatory of a partially authorised consent starts their own BankID on the same consent. */
  signAsSignatory: (method: ConnectMethod) => Promise<void>
  /** Leave for the bank's own page (the top window, never a popup). */
  continueToBank: (url: string) => void
  activate: () => Promise<void>
  /**
   * Start the payments verification and hand its URL to `deliver` (a new
   * tab, a mailto); the status is then polled while the offer step stays.
   */
  openVerification: (kind: VerificationStartKind, deliver: (url: string) => void | Promise<void>) => Promise<void>
  /** Remove a half-made connection (a BankID that was closed over, an unsaved selection). A resumed second-signatory connection stays. */
  abandon: () => Promise<void>
}

/**
 * The state machine and the side effects of one Koppla banken, shared by the
 * dialog and the signatory page: the signer and payments probes at open, the
 * BIC resolution of a locked bank, the bank's details (how it signs, its
 * sparbanker), the consent poll with the typed personnummer, the bank's own
 * page (leave and come back), Svea's second round, the first sync, the
 * verification poll and the QR countdown. The reducer
 * (connect-flow-reducer.ts) holds the transitions; this hook drives them.
 */
export function useBankConnectController({ session, backend, banks, banksFailed, onConnected }: BankConnectControllerOptions): BankConnectController {
  const t = useTranslations('bank_connect')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [state, dispatch] = useReducer(flowReducer, session, (s) => openFlow(s.mode, s.options))
  const [signerKnown, setSignerKnown] = useState(false)
  const [personalNumberInvalid, setPersonalNumberInvalid] = useState(false)
  const [paymentsBusy, setPaymentsBusy] = useState<VerificationStartKind | null>(null)
  const connectedReported = useRef(false)
  const backendRef = useRef(backend)
  backendRef.current = backend
  const onConnectedRef = useRef(onConnected)
  onConnectedRef.current = onConnected
  const mobile = useMediaQuery(MOBILE_QUERY)

  const connectionId = state.connectionId
  const returnTo = session.returnTo

  function describe(error: unknown, fallback: string): string {
    const body = error instanceof OpenPaymentsClientError || error instanceof PaymentsClientError ? error.body : null
    return getErrorMessage(body, { locale, fallback })
  }

  // Whether the person has a signer on file and whether payments through the
  // bank are on offer (available, not yet verified). One probe of each at
  // open, so the step count is settled before the person reaches the accounts.
  useEffect(() => {
    let cancelled = false
    const stopWatching = backendRef.current.watchSignerKnown((known) => {
      if (!cancelled) setSignerKnown(known)
    })
    const payments = backendRef.current.payments
    if (!payments) {
      dispatch({ type: 'payments_offer', offered: false, verification: null })
    } else {
      payments
        .probe()
        .then((offer) => {
          if (!cancelled) dispatch({ type: 'payments_offer', ...offer })
        })
        .catch(() => {
          if (!cancelled) dispatch({ type: 'payments_offer', offered: false, verification: null })
        })
    }
    return () => {
      cancelled = true
      stopWatching()
    }
  }, [])

  // A switch or a renewal knows the bank from its row by name only: the BIC
  // comes from the bank list (a sparbank resolves to Swedbank's). A name the
  // list does not know unlocks the list.
  const bankToResolve = state.bank && !state.bank.bic ? state.bank.name : null
  useEffect(() => {
    if (!bankToResolve || (!banks && !banksFailed)) return
    const match = banks ? resolveBankByName(banks, bankToResolve) : null
    dispatch({ type: 'bank_resolved', bic: match?.bic ?? null })
  }, [bankToResolve, banks, banksFailed])

  // The chosen bank's details: how it signs and which sparbanker it reaches.
  // One read per bank per flow; the server answers from its own 24 h cache.
  const chosenBic = state.bank?.bic || null
  const [bankDetails, setBankDetails] = useState<OpenPaymentsBankDetails | null>(null)
  useEffect(() => {
    if (!chosenBic) return
    let cancelled = false
    backendRef.current.bank
      .fetchBankDetails(chosenBic)
      .then((details) => {
        if (!cancelled) setBankDetails(details)
      })
      .catch(() => {
        // Without the details the flow goes on with what the list said.
      })
    return () => {
      cancelled = true
    }
  }, [chosenBic])
  const knownDetails = state.bankDetails
  useEffect(() => {
    if (bankDetails && bankDetails !== knownDetails) dispatch({ type: 'bank_details_loaded', details: bankDetails })
  }, [bankDetails, knownDetails])

  // A resumed connection names its bank on the row: read it once, so the
  // title and the bank's-page texts can say where the person signs.
  const needsBank = state.mode === 'resume' && state.bank === null
  useEffect(() => {
    if (!needsBank || !connectionId) return
    let cancelled = false
    backendRef.current.bank
      .fetchConnection(connectionId)
      .then((connection) => {
        if (!cancelled && connection.bank_name) dispatch({ type: 'connection_known', bank: { bic: connection.bic ?? '', name: connection.bank_name } })
      })
      .catch(() => {
        // The title falls back to the generic one.
      })
    return () => {
      cancelled = true
    }
  }, [needsBank, connectionId])

  // Poll while the bank works on the consent. One request at a time; a
  // consent waiting for a second signatory is asked about less often. The
  // typed personnummer rides along (the bank wants the PSU on every call);
  // the server never stores it.
  const polling = pollingActive(state)
  const secondSigner = state.pollState === 'partially_authorised'
  const pollAtOnce = state.attempt === null
  const typedPersonalNumber = signerKnown ? null : normalizePersonalNumber(state.personalNumber)
  useEffect(() => {
    if (!polling || !connectionId) return
    return startPollLoop({
      poll: (signal) => backendRef.current.bank.pollConnection(connectionId, signal, typedPersonalNumber ? { personal_number: typedPersonalNumber } : {}),
      onResult: (poll) => {
        dispatch({ type: 'polled', poll })
        return poll.state === 'pending' || poll.state === 'partially_authorised'
      },
      intervalMs: secondSigner ? SECOND_SIGNER_POLL_MS : CONSENT_POLL_MS,
      immediate: pollAtOnce,
    })
  }, [polling, connectionId, secondSigner, pollAtOnce, typedPersonalNumber])

  // Svea's second round went through: the connection is live, run the first
  // sync, then read the connection as the routes describe it. A 429 (synced
  // recently, or the bank limits reads) is calm: the import runs on its own;
  // a bank busy for a moment gets one calm line.
  const confirmed = state.confirmed
  const bankNameNow = state.bank?.name ?? null
  const bankBic = state.bank?.bic ?? null
  const consentExpires = state.consentExpires
  useEffect(() => {
    if (!confirmed || !connectionId) return
    let cancelled = false
    const fallbackView: ConnectionView = {
      connection_id: connectionId,
      bank_name: bankNameNow,
      bic: bankBic,
      provider: 'open_payments',
      status: 'active',
      consent_expires: consentExpires,
      last_synced_at: null,
      initial_sync_completed_at: null,
      error_message: null,
      accounts: [],
    }
    void (async () => {
      let sync: { imported: number } | null = null
      let syncPending = false
      try {
        sync = { imported: (await backendRef.current.bank.syncConnection(connectionId)).imported }
      } catch (error) {
        if (cancelled) return
        if (isSyncCooldown(error)) syncPending = true
        else if (isBankBusy(error)) {
          syncPending = true
          toast({ title: t('bank_busy') })
        } else toast({ title: t('activate_failed_title'), description: describe(error, t('activate_failed_title')), variant: 'destructive' })
      }
      const connection = await backendRef.current.bank.fetchConnection(connectionId).catch(() => fallbackView)
      if (!cancelled) dispatch({ type: 'activated', connection, sync, syncPending })
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per confirmed consent
  }, [confirmed, connectionId])

  // The connection is live: tell the surface once.
  const connection = state.connection
  const firstSync = state.firstSync
  useEffect(() => {
    if (!connection || connectedReported.current) return
    connectedReported.current = true
    onConnectedRef.current?.(connection, firstSync)
  }, [connection, firstSync])

  // A verification form is out (opened here, or earlier by someone, or with
  // the firmatecknare): look every 15 s while the offer step stays, asking
  // the provider each time, until it answers valid.
  const verifying =
    state.step === 'payments' &&
    state.verification !== 'valid' &&
    (state.verificationUrl !== null || (state.verificationState !== null && FORM_OUT_STATES.has(state.verificationState)))
  useEffect(() => {
    const payments = backendRef.current.payments
    if (!verifying || !payments) return
    return startPollLoop({
      poll: () => payments.fetchVerification({ refresh: true }),
      onResult: (verification) => {
        dispatch({ type: 'verification_polled', verification })
        return verification.status !== 'valid'
      },
      intervalMs: VERIFICATION_POLL_MS,
    })
  }, [verifying])

  // The QR's 30 seconds, counted from the bank's step (a new step is a new QR).
  const qrOnScreen = polling && !secondSigner && Boolean(state.attempt?.challenge?.qrData || state.attempt?.challenge?.qrImage)
  const stepKey = state.attempt ? `${state.attempt.authorisation_id}:${state.consentStep ?? '-'}:${state.secondConsent ? 2 : 1}` : null
  const secondsLeft = useQrCountdown(stepKey, qrOnScreen)

  // The bank's own page replaces this one: the top window goes there (a
  // popup would lose the person on a phone and be blocked on a desktop), and
  // the bank sends it back to this surface's page with the connection named.
  function continueToBank(url: string) {
    if (connectionId) backend.beforeLeavingForBank?.(connectionId, state)
    window.location.assign(url)
  }

  // A bank that signs in our screen anyway answers a redirect start with a
  // QR: the attempt's own method decides, not the one asked for.
  function leaveForBank(result: CreateConnectionResult) {
    const url = result.attempt.challenge?.redirectUrl
    if (result.attempt.method === 'redirect' && result.attempt.state === 'pending' && url) {
      backend.beforeLeavingForBank?.(result.connection_id, state)
      window.location.assign(url)
    }
  }

  async function start(method: ConnectMethod) {
    if (!state.bank) return
    let personalNumber: string | undefined
    if (!signerKnown) {
      const normalized = normalizePersonalNumber(state.personalNumber)
      if (!normalized) {
        setPersonalNumberInvalid(true)
        return
      }
      personalNumber = normalized
    }
    setPersonalNumberInvalid(false)
    dispatch({ type: 'method_set', method })
    dispatch({ type: 'start' })
    try {
      const result = await backend.bank.createConnection({
        bic: state.bank.bic,
        affiliated_aspsp_id: state.affiliate?.id,
        account_context: state.context ?? 'corporate',
        method,
        personal_number: personalNumber,
        replace_connection_id: state.replaceConnectionId ?? undefined,
        // Always named when the surface has a page: the server picks the bank's
        // page for a bank that signs only there, whatever was asked for.
        return_to: returnTo ?? undefined,
      })
      dispatch({ type: 'started', result })
      leaveForBank(result)
    } catch (error) {
      dispatch({ type: 'start_failed', message: describe(error, t('start_failed_title')) })
    }
  }

  // A restart or a select may start a BankID: the method and, when nothing
  // is on file, the typed personnummer again (the server never stores it),
  // and the page to come back to, so a bank that signs on its own page
  // (Svea's second consent included) can be started that way.
  function signerInput(method: ConnectMethod = state.method): SignerInput {
    const typed = signerKnown ? null : normalizePersonalNumber(state.personalNumber)
    return {
      method,
      ...(typed ? { personal_number: typed } : {}),
      ...(returnTo ? { return_to: returnTo } : {}),
    }
  }

  async function restart(method: ConnectMethod = state.method) {
    if (!connectionId) return
    dispatch({ type: 'start' })
    try {
      const result = await backend.bank.restartConnection(connectionId, signerInput(method))
      dispatch({ type: 'started', result })
      leaveForBank(result)
    } catch (error) {
      dispatch({ type: 'start_failed', message: describe(error, t('restart_failed_title')) })
    }
  }

  // The second signatory of a partially authorised consent: their own BankID
  // on the same consent, with their personnummer when none is on file. The
  // bank then has both mandated authorisations and the consent turns valid.
  async function signAsSignatory(method: ConnectMethod) {
    if (!signerKnown && !normalizePersonalNumber(state.personalNumber)) {
      setPersonalNumberInvalid(true)
      return
    }
    setPersonalNumberInvalid(false)
    dispatch({ type: 'method_set', method })
    await restart(method)
  }

  async function activate() {
    if (!connectionId) return
    dispatch({ type: 'activate' })
    try {
      const result = await backend.bank.selectAccounts(connectionId, selectionPayload(state.accounts, state.selection), signerInput())
      if (isSecondConsent(result)) {
        dispatch({ type: 'second_consent', attempt: result.attempt })
        // Svea's second consent may sign on the bank's page: leave as for a start.
        leaveForBank({ connection_id: connectionId, attempt: result.attempt })
      } else dispatch({ type: 'activated', connection: result.connection, sync: result.sync ? { imported: result.sync.imported } : null, syncPending: result.sync_pending })
    } catch (error) {
      dispatch({ type: 'activate_failed', message: describe(error, t('activate_failed_title')) })
    }
  }

  // Every start makes a fresh 24-hour link at the provider. A mail or a copy
  // hands the form to a firmatecknare, and the state says so (awaiting_signatory)
  // until the provider answers valid or the link runs out.
  async function openVerification(kind: VerificationStartKind, deliver: (url: string) => void | Promise<void>) {
    if (!backend.payments) return
    setPaymentsBusy(kind)
    try {
      const started = await backend.payments.startVerification({ handoff: kind !== 'verify' })
      await deliver(started.url)
      dispatch({ type: 'verification_opened', url: started.url, expiresAt: started.expires_at, state: started.state })
    } catch (error) {
      toast({ title: t('verification_failed_title'), description: describe(error, t('verification_failed_title')), variant: 'destructive' })
    } finally {
      setPaymentsBusy(null)
    }
  }

  // Closing over a running BankID or an unsaved selection: the half-made
  // connection is removed so no row lingers. A connection resumed for the
  // second signatory belongs to the first and stays; one the person came
  // back to from the bank's page is their own and goes.
  async function abandon() {
    if (connectionId && !state.connection && (state.mode !== 'resume' || state.returned !== null)) {
      try {
        await backend.bank.deleteConnection(connectionId)
      } catch {
        // The server sweeps abandoned attempts.
      }
    }
  }

  const approach = signingApproach(state)
  return {
    state,
    dispatch,
    signerKnown,
    personalNumberInvalid,
    paymentsBusy,
    secondsLeft,
    approach,
    redirectHelp: approach === 'redirect' || redirectInFlight(state),
    mobile,
    bankName: displayBankName(state),
    describe,
    start,
    restart,
    signAsSignatory,
    continueToBank,
    activate,
    openVerification,
    abandon,
  }
}
