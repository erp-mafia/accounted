'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { useQrCountdown } from '@/components/bankid/use-qr-countdown'
import { fetchCompanyVerification, fetchPaymentsAvailability, PaymentsClientError, startCompanyVerification } from '@/components/payments/payments-client'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { notifyBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import { flowReducer, openFlow, pollingActive } from './connect-flow-reducer'
import { dismissPolicy, stepPosition } from './flow-steps'
import {
  createOpenPaymentsConnection,
  deleteOpenPaymentsConnection,
  fetchOpenPaymentsConnection,
  fetchOpenPaymentsOverview,
  isSecondConsent,
  isSyncCooldown,
  OpenPaymentsClientError,
  pollOpenPaymentsConnection,
  restartOpenPaymentsConnection,
  selectOpenPaymentsAccounts,
  syncOpenPaymentsConnection,
  type ConnectMethod,
  type ConnectionView,
  type SignerInput,
} from './open-payments-client'
import { normalizePersonalNumber } from './personal-number'
import { startPollLoop } from './poll-loop'
import { selectionPayload } from './account-selection'
import { resumeFlowUrl, verificationMailto } from './verification-mail'
import { useOpenPaymentsAvailability } from './use-open-payments-availability'
import type { BankConnectFlow, BankConnectSession } from './use-bank-connect-flow'
import { AccountsStep } from './steps/AccountsStep'
import { BankIdStep } from './steps/BankIdStep'
import { BankPickStep } from './steps/BankPickStep'
import { DoneStep, IntroStep, PaymentsStep } from './steps/QuietSteps'

/** How often the consent is asked about while the bank's BankID runs: the animated QR changes every second. */
const CONSENT_POLL_MS = 1000
/** A consent waiting for a second signatory changes rarely. */
const SECOND_SIGNER_POLL_MS = 5000
/** The provider's verification form is filled in by hand: a quarter minute between looks. */
const VERIFICATION_POLL_MS = 15_000

interface BankConnectDialogProps {
  flow: BankConnectFlow
  /** Called once per dialog when the connection is live (accounts chosen, first sync run, running on, or attempted). */
  onConnected?: (connection: ConnectionView, sync: { imported: number } | null) => void
}

/**
 * Koppla banken: the one dialog for a new Open Payments connection, a switch
 * from Enable Banking and a renewal. Rendered once per surface next to the
 * `useBankConnectFlow()` that opens it; a new session key gives a clean state.
 */
export function BankConnectDialog({ flow, onConnected }: BankConnectDialogProps) {
  if (!flow.session) return null
  return <BankConnectDialogInner key={flow.session.key} session={flow.session} onClose={flow.close} onConnected={onConnected} />
}

function BankConnectDialogInner({ session, onClose, onConnected }: { session: BankConnectSession; onClose: () => void; onConnected?: BankConnectDialogProps['onConnected'] }) {
  const t = useTranslations('bank_connect')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const company = useCompanyOptional()?.company ?? null
  const availability = useOpenPaymentsAvailability()
  const [state, dispatch] = useReducer(flowReducer, session, (s) => openFlow(s.mode, s.options))
  const [signerKnown, setSignerKnown] = useState(false)
  const [personalNumberInvalid, setPersonalNumberInvalid] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [paymentsBusy, setPaymentsBusy] = useState<'verify' | 'mail' | null>(null)
  const connectedReported = useRef(false)

  const soleTrader = company ? usesPersonnummerAsOrgNumber(company.entity_type) : false
  const connectionId = state.connectionId

  function describe(error: unknown, fallback: string): string {
    const body = error instanceof OpenPaymentsClientError || error instanceof PaymentsClientError ? error.body : null
    return getErrorMessage(body, { locale, fallback })
  }

  // Whether the person has a signer on file (the bank feed's own answer;
  // the payments availability's signer_known stands in until it lands) and
  // whether payments through the bank are on offer (available, not yet
  // verified). One read of each at open, so the step count is settled before
  // the person reaches the accounts.
  useEffect(() => {
    let cancelled = false
    let overviewAnswered = false
    fetchOpenPaymentsOverview()
      .then((overview) => {
        if (cancelled) return
        overviewAnswered = true
        setSignerKnown(overview.signer_known)
      })
      .catch(() => {
        // The payments availability's answer stands.
      })
    fetchPaymentsAvailability()
      .then(async (availability) => {
        if (cancelled) return
        if (!overviewAnswered) setSignerKnown(availability.signer_known)
        if (!availability.available) {
          dispatch({ type: 'payments_offer', offered: false, verification: null, validUntil: null })
          return
        }
        try {
          const verification = await fetchCompanyVerification()
          if (cancelled) return
          dispatch({ type: 'payments_offer', offered: verification.status !== 'valid', verification: verification.status, validUntil: verification.valid_until })
        } catch {
          if (!cancelled) dispatch({ type: 'payments_offer', offered: true, verification: 'unknown', validUntil: null })
        }
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'payments_offer', offered: false, verification: null, validUntil: null })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // A switch or a renewal knows the bank from its row by name only: the BIC
  // comes from the bank list. A name the list does not know unlocks the list.
  const bankToResolve = state.bank && !state.bank.bic ? state.bank.name : null
  const banks = availability.banks
  const banksFailed = availability.status === 'unavailable'
  useEffect(() => {
    if (!bankToResolve || (!banks && !banksFailed)) return
    const wanted = bankToResolve.trim().toLowerCase()
    const match = banks?.find((b) => b.name.trim().toLowerCase() === wanted) ?? banks?.find((b) => b.name.toLowerCase().includes(wanted) || wanted.includes(b.name.toLowerCase()))
    dispatch({ type: 'bank_resolved', bic: match?.bic ?? null })
  }, [bankToResolve, banks, banksFailed])

  // Poll while the bank works on the consent. One request at a time; a
  // consent waiting for a second signatory is asked about less often.
  const polling = pollingActive(state)
  const secondSigner = state.pollState === 'partially_authorised'
  const pollAtOnce = state.attempt === null
  useEffect(() => {
    if (!polling || !connectionId) return
    return startPollLoop({
      poll: (signal) => pollOpenPaymentsConnection(connectionId, signal),
      onResult: (poll) => {
        dispatch({ type: 'polled', poll })
        return poll.state === 'pending' || poll.state === 'partially_authorised'
      },
      intervalMs: secondSigner ? SECOND_SIGNER_POLL_MS : CONSENT_POLL_MS,
      immediate: pollAtOnce,
    })
  }, [polling, connectionId, secondSigner, pollAtOnce])

  // Svea's second round went through: the connection is live, run the first
  // sync, then read the connection as the routes describe it. A 429 (synced
  // recently, or the bank limits reads) is calm: the import runs on its own.
  const confirmed = state.confirmed
  const bankName = state.bank?.name ?? null
  const bankBic = state.bank?.bic ?? null
  const consentExpires = state.consentExpires
  useEffect(() => {
    if (!confirmed || !connectionId) return
    let cancelled = false
    const fallbackView: ConnectionView = {
      connection_id: connectionId,
      bank_name: bankName,
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
        sync = { imported: (await syncOpenPaymentsConnection(connectionId)).imported }
      } catch (error) {
        if (cancelled) return
        if (isSyncCooldown(error)) syncPending = true
        else toast({ title: t('activate_failed_title'), description: describe(error, t('activate_failed_title')), variant: 'destructive' })
      }
      const connection = await fetchOpenPaymentsConnection(connectionId).catch(() => fallbackView)
      if (!cancelled) dispatch({ type: 'activated', connection, sync, syncPending })
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per confirmed consent
  }, [confirmed, connectionId])

  // The connection is live: tell the surfaces that show bank state, once.
  const connection = state.connection
  const firstSync = state.firstSync
  useEffect(() => {
    if (!connection || connectedReported.current) return
    connectedReported.current = true
    notifyBankSyncUpdated()
    void invalidateReferenceData(['ref:cash-accounts', 'ref:accounts'])
    onConnected?.(connection, firstSync)
  }, [connection, firstSync, onConnected])

  // The verification form is open somewhere: look every 15 s while the dialog stays.
  const verifying = state.step === 'payments' && state.verificationUrl !== null && state.verification !== 'valid'
  useEffect(() => {
    if (!verifying) return
    return startPollLoop({
      poll: () => fetchCompanyVerification(),
      onResult: (verification) => {
        dispatch({ type: 'verification_polled', status: verification.status, validUntil: verification.valid_until })
        return verification.status !== 'valid'
      },
      intervalMs: VERIFICATION_POLL_MS,
    })
  }, [verifying])

  // The QR's 30 seconds, counted from the bank's step (a new step is a new QR).
  const qrOnScreen = polling && !secondSigner && Boolean(state.attempt?.challenge?.qrData || state.attempt?.challenge?.qrImage)
  const stepKey = state.attempt ? `${state.attempt.authorisation_id}:${state.consentStep ?? '-'}:${state.secondConsent ? 2 : 1}` : null
  const secondsLeft = useQrCountdown(stepKey, qrOnScreen)

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
      const result = await createOpenPaymentsConnection({
        bic: state.bank.bic,
        affiliated_aspsp_id: state.affiliateId ?? undefined,
        account_context: state.context ?? 'corporate',
        method,
        personal_number: personalNumber,
        replace_connection_id: state.replaceConnectionId ?? undefined,
      })
      dispatch({ type: 'started', result })
    } catch (error) {
      dispatch({ type: 'start_failed', message: describe(error, t('start_failed_title')) })
    }
  }

  // A restart or a select may start a BankID: the method and, when nothing
  // is on file, the typed personnummer again (the server never stores it).
  function signerInput(): SignerInput {
    const typed = signerKnown ? null : normalizePersonalNumber(state.personalNumber)
    return typed ? { method: state.method, personal_number: typed } : { method: state.method }
  }

  async function restart() {
    if (!connectionId) return
    dispatch({ type: 'start' })
    try {
      dispatch({ type: 'started', result: await restartOpenPaymentsConnection(connectionId, signerInput()) })
    } catch (error) {
      dispatch({ type: 'start_failed', message: describe(error, t('restart_failed_title')) })
    }
  }

  async function activate() {
    if (!connectionId) return
    dispatch({ type: 'activate' })
    try {
      const result = await selectOpenPaymentsAccounts(connectionId, selectionPayload(state.accounts, state.selection), signerInput())
      if (isSecondConsent(result)) dispatch({ type: 'second_consent', attempt: result.attempt })
      else dispatch({ type: 'activated', connection: result.connection, sync: result.sync ? { imported: result.sync.imported } : null, syncPending: result.sync_pending })
    } catch (error) {
      dispatch({ type: 'activate_failed', message: describe(error, t('activate_failed_title')) })
    }
  }

  async function verifyNow() {
    setPaymentsBusy('verify')
    try {
      const { url } = await startCompanyVerification()
      window.open(url, '_blank', 'noopener,noreferrer')
      dispatch({ type: 'verification_opened', url })
    } catch (error) {
      toast({ title: t('verification_failed_title'), description: describe(error, t('verification_failed_title')), variant: 'destructive' })
    } finally {
      setPaymentsBusy(null)
    }
  }

  async function sendToSignatory() {
    setPaymentsBusy('mail')
    try {
      const { url } = await startCompanyVerification()
      window.location.href = verificationMailto({
        subject: t('mail_subject'),
        lines: [t('mail_line_1', { company: company?.name ?? '' }), t('mail_line_2')],
        url,
      })
      dispatch({ type: 'verification_opened', url })
    } catch (error) {
      toast({ title: t('verification_failed_title'), description: describe(error, t('verification_failed_title')), variant: 'destructive' })
    } finally {
      setPaymentsBusy(null)
    }
  }

  async function copyReminder() {
    if (!connectionId) return
    try {
      await navigator.clipboard.writeText(resumeFlowUrl(window.location.origin, connectionId))
      toast({ title: t('reminder_copied_title'), description: t('reminder_copied') })
    } catch {
      toast({ title: t('reminder_copy_failed_title'), variant: 'destructive' })
    }
  }

  function requestClose() {
    if (dismissPolicy(state.step) === 'confirm') {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  // Closing over a running BankID or an unsaved selection: the half-made
  // connection is removed so no row lingers. A resumed connection belongs to
  // the first signatory and stays.
  async function abandon() {
    if (connectionId && !state.connection && state.mode !== 'resume') {
      try {
        await deleteOpenPaymentsConnection(connectionId)
      } catch {
        // The server sweeps abandoned attempts.
      }
    }
    onClose()
  }

  const position = stepPosition(state.step, state.mode, state.paymentsOffered)
  const title = state.step === 'intro' ? t('title_intro') : state.step === 'done' ? t('title_done') : t(`title_${state.mode}`)
  const cancelButton = (
    <Button variant="secondary" onClick={requestClose}>
      {t('cancel')}
    </Button>
  )

  return (
    <>
      <Dialog open onOpenChange={(next) => !next && requestClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            {position && (
              <p className="text-[12.5px] tabular-nums text-muted-foreground" data-ph-unmask="">
                {t('step_of', { n: position.n, total: position.total })}
              </p>
            )}
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{title}</DialogDescription>
          </DialogHeader>

          {state.step === 'intro' && <IntroStep deadline={session.options.deadline ?? null} onContinue={() => dispatch({ type: 'continue' })} closeButton={cancelButton} />}
          {state.step === 'bank' && (
            <BankPickStep
              state={state}
              dispatch={dispatch}
              banks={banks}
              banksFailed={banksFailed}
              soleTrader={soleTrader}
              onContinue={() => dispatch({ type: 'to_bankid' })}
              closeButton={cancelButton}
            />
          )}
          {state.step === 'bankid' && (
            <BankIdStep
              state={state}
              dispatch={dispatch}
              signerKnown={signerKnown}
              personalNumberInvalid={personalNumberInvalid}
              secondsLeft={secondsLeft}
              onStart={start}
              onRestart={restart}
              onCopyReminder={copyReminder}
              closeButton={cancelButton}
            />
          )}
          {state.step === 'accounts' && <AccountsStep state={state} dispatch={dispatch} onActivate={activate} closeButton={cancelButton} />}
          {state.step === 'payments' && (
            <PaymentsStep state={state} busy={paymentsBusy} onVerifyNow={verifyNow} onSendToSignatory={sendToSignatory} onSkip={() => dispatch({ type: 'payments_done' })} />
          )}
          {state.step === 'done' && <DoneStep state={state} onClose={onClose} />}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={t('abort_title')}
        description={t(state.step === 'accounts' ? 'abort_description_accounts' : 'abort_description_bankid')}
        confirmLabel={t('abort_confirm')}
        cancelLabel={t('abort_keep')}
        destructive
        onConfirm={abandon}
      />
    </>
  )
}
