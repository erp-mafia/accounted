'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { StatusGlyph } from '@/components/ui/status-glyph'
import { useBranding } from '@/lib/branding/brand-context'
import {
  StandaloneFrom,
  StandaloneHeading,
  StandaloneOutcome,
  StandalonePage,
  StandaloneSmall,
} from '@/components/standalone/StandalonePage'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { HelpPopover } from '@/components/ui/help-popover'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { BankMark } from '@/components/banks/BankMark'
import { BANK_CONNECT_SIGNATORY_TARGET } from '@/lib/bank-feed/return-url'
import { FlowHelp, FlowSteps, flowPosition, flowShowsBankMark, flowTitle } from './BankConnectSteps'
import type { FlowBank, FlowReturn } from './connect-flow-reducer'
import { dismissPolicy, type FlowMode } from './flow-steps'
import type { OpenPaymentsBank } from './open-payments-client'
import { parseBankConnectReturn, stripBankConnectReturn } from './return-link'
import { createSignatoryBackend, recallSignatoryPersonalNumber } from './signatory-client'
import { useBankConnectController } from './use-bank-connect-controller'
import type { BankConnectSession } from './use-bank-connect-flow'

export interface SignatoryConnectPageProps {
  token: string
  companyName: string
  /** Who asked: the byrå's name, or the company's own. */
  requester: string
  /** Enskild firma: the private account used in the business is a choice. */
  soleTrader: boolean
  mode: FlowMode
  /** The bank the link names, by BIC; the name comes from the bank list. Null lets the firmatecknare pick. */
  bic: string | null
  /** The connection a switch or a renewal replaces, with the bank as its row names it. */
  replace: { connectionId: string; bankName: string | null } | null
  offerPayments: boolean
}

type Outcome = 'open' | 'cancelled' | 'finished'

/** A return from the bank's own page, read from the URL once; null when the page was opened from the link itself. */
interface ReturnedFrom {
  connectionId: string
  returned: FlowReturn | null
}

/**
 * The signatory page: the same Koppla banken flow as the dialog, rendered on
 * a page a firmatecknare opens from a link, without an Accounted login. Every
 * call goes through the token routes; the personnummer is typed here and
 * sent to the bank, never stored. A bank that signs on its own page sends the
 * browser back to this very link with the connection named
 * (?bank_connect=<id>&result=ok|error), and the flow resumes at its BankID
 * step. The header names the company and who asked.
 */
export function SignatoryConnectPage(props: SignatoryConnectPageProps) {
  const t = useTranslations('koppla')
  const tSigning = useTranslations('signing_page')
  const { appName } = useBranding()
  const searchParams = useSearchParams()
  const backend = useMemo(() => createSignatoryBackend(props.token, { offerPayments: props.offerPayments }), [props.token, props.offerPayments])
  const [banks, setBanks] = useState<OpenPaymentsBank[] | null>(null)
  const [banksFailed, setBanksFailed] = useState(false)
  // Bumped by "Försök igen": asks for the bank list again. The failure stays
  // until the new answer, so the open flow does not reset while it waits.
  const [banksAttempt, setBanksAttempt] = useState(0)
  // The return parameters are read once and dropped from the URL: a reload
  // after that opens the link afresh, never the bank's answer a second time.
  const [returnedFrom] = useState<ReturnedFrom | null>(() => {
    const parsed = parseBankConnectReturn(searchParams)
    return parsed && !parsed.renew ? { connectionId: parsed.connectionId, returned: parsed.returned } : null
  })
  useEffect(() => {
    if (returnedFrom) window.history.replaceState(window.history.state, '', stripBankConnectReturn(window.location.href))
  }, [returnedFrom])

  useEffect(() => {
    let cancelled = false
    backend.bank
      .fetchAvailability()
      .then((availability) => {
        if (cancelled) return
        if (availability.available) {
          setBanks(availability.banks)
          setBanksFailed(false)
        } else setBanksFailed(true)
      })
      .catch(() => {
        if (!cancelled) setBanksFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [backend, banksAttempt])

  // Back from the bank's page: resume the connection at its BankID step. From
  // the link itself: the link names the bank by BIC alone and the list gives
  // it its name; a replaced connection names its bank, so that session can
  // start at once.
  const session = useMemo<BankConnectSession | null>(() => {
    if (returnedFrom) {
      return { key: 1, mode: 'resume', options: { connectionId: returnedFrom.connectionId, returned: returnedFrom.returned }, returnTo: BANK_CONNECT_SIGNATORY_TARGET }
    }
    let bank: FlowBank | null = null
    if (props.replace) bank = { bic: props.bic ?? '', name: props.replace.bankName ?? '' }
    else if (props.bic) {
      if (!banks && !banksFailed) return null
      const match = banks?.find((b) => b.bic.toUpperCase() === props.bic!.toUpperCase()) ?? null
      bank = match ? { bic: match.bic, name: match.name, decoupled: match.decoupled, redirect: match.redirect } : null
    }
    return { key: 1, mode: props.mode, options: { bank, replaceConnectionId: props.replace?.connectionId ?? null }, returnTo: BANK_CONNECT_SIGNATORY_TARGET }
  }, [returnedFrom, props.bic, props.mode, props.replace, banks, banksFailed])

  return (
    <StandalonePage width="link" brand={false}>
      <StandaloneFrom name={props.companyName} via={tSigning('via', { platform: appName })} />
      <StandaloneHeading
        className="mt-5"
        title={t('eyebrow')}
        sub={<span data-ph-mask="">{t('requested_by', { requester: props.requester })}</span>}
      />
      <div className="mt-5">
        {session ? (
          <SignatoryFlow key={session.key} token={props.token} session={session} backend={backend} banks={banks} banksFailed={banksFailed} onRetryBanks={() => setBanksAttempt((n) => n + 1)} soleTrader={props.soleTrader} />
        ) : (
          <LateReveal className="space-y-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </LateReveal>
        )}
      </div>
      <StandaloneSmall>{t('footer_provider')}</StandaloneSmall>
    </StandalonePage>
  )
}

function SignatoryFlow({
  token,
  session,
  backend,
  banks,
  banksFailed,
  onRetryBanks,
  soleTrader,
}: {
  token: string
  session: BankConnectSession
  backend: ReturnType<typeof createSignatoryBackend>
  banks: OpenPaymentsBank[] | null
  banksFailed: boolean
  onRetryBanks: () => void
  soleTrader: boolean
}) {
  const t = useTranslations('koppla')
  const tFlow = useTranslations('bank_connect')
  const [outcome, setOutcome] = useState<Outcome>('open')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const controller = useBankConnectController({ session, backend, banks, banksFailed })
  const { state, dispatch } = controller

  // Back from the bank's page, the typed personnummer is what the page state
  // lost on the way: the poll and a restart carry it again (the bank wants
  // the PSU on every call), so it is recalled once for this connection.
  const resumedId = session.mode === 'resume' ? (session.options.connectionId ?? null) : null
  useEffect(() => {
    if (!resumedId) return
    const recalled = recallSignatoryPersonalNumber(token, resumedId)
    if (recalled) dispatch({ type: 'personal_number_set', value: recalled })
  }, [resumedId, token, dispatch])

  function requestCancel() {
    if (dismissPolicy(state.step) === 'confirm') {
      setConfirmCancel(true)
      return
    }
    setOutcome('cancelled')
  }

  async function cancel() {
    await controller.abandon()
    setOutcome('cancelled')
  }

  if (outcome !== 'open') {
    return (
      <StandaloneOutcome
        className="border-t-hairline pt-4"
        mark={outcome === 'finished' ? <StatusGlyph tone="ok" size={16} /> : undefined}
        title={t(outcome === 'finished' ? 'finished_title' : 'cancelled_title')}
      >
        {t(outcome === 'finished' ? 'finished_body' : 'cancelled_body')}
      </StandaloneOutcome>
    )
  }

  const position = flowPosition(state)
  const titleBank = controller.bankName
  const titleMark = flowShowsBankMark(state, titleBank)
  const title = flowTitle(state, titleBank, tFlow)
  const cancelButton = (
    <Button variant="outline" onClick={requestCancel}>
      {tFlow('cancel')}
    </Button>
  )

  return (
    <>
      {/* The flow's footer bleeds 20px (a dialog's inset): on a phone the
          panel's inset is 16px, so the section adds the missing 4px. */}
      <section className="space-y-4 border-t-hairline pt-4 max-sm:px-1">
        <div className="space-y-1">
          {position && (
            <p className="text-xs tabular-nums text-muted-foreground" data-ph-unmask="">
              {tFlow('step_of', { n: position.n, total: position.total })}
            </p>
          )}
          <div className="flex items-center gap-2">
            {titleMark && <BankMark bankName={titleBank} size={24} />}
            <h2 className="text-[15px] leading-[22px] text-strong" data-ph-mask={titleMark ? '' : undefined}>
              {title}
            </h2>
            {state.step !== 'done' && (
              <HelpPopover className="shrink-0">
                <div className="space-y-2">
                  <FlowHelp controller={controller} />
                  <p>{t('help_signatory')}</p>
                </div>
              </HelpPopover>
            )}
          </div>
        </div>
        <FlowSteps
          controller={controller}
          session={session}
          banks={banks}
          banksFailed={banksFailed}
          onRetryBanks={onRetryBanks}
          soleTrader={soleTrader}
          closeButton={cancelButton}
          onClose={() => setOutcome('finished')}
        />
      </section>
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={tFlow('abort_title')}
        description={tFlow(state.step === 'accounts' ? 'abort_description_accounts' : 'abort_description_bankid')}
        confirmLabel={tFlow('abort_confirm')}
        cancelLabel={tFlow('abort_keep')}
        destructive
        onConfirm={cancel}
      />
    </>
  )
}
