'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { HelpPopover } from '@/components/ui/help-popover'
import { useToast } from '@/components/ui/use-toast'
import { BankMark } from '@/components/banks/BankMark'
import { fetchCompanyVerification, fetchPaymentsAvailability, startCompanyVerification } from '@/components/payments/payments-client'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { notifyBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import { FlowHelp, FlowSteps, flowPosition, flowShowsBankMark, flowTitle } from './BankConnectSteps'
import { dismissPolicy } from './flow-steps'
import { fetchOpenPaymentsOverview, sessionOpenPaymentsApi, type ConnectionView } from './open-payments-client'
import { useBankConnectController, type BankConnectBackend } from './use-bank-connect-controller'
import { resumeFlowUrl, verificationMailto } from './verification-mail'
import { useOpenPaymentsAvailability } from './use-open-payments-availability'
import type { BankConnectFlow, BankConnectSession } from './use-bank-connect-flow'

interface BankConnectDialogProps {
  flow: BankConnectFlow
  /** Called once per dialog when the connection is live (accounts chosen, first sync run, running on, or attempted). */
  onConnected?: (connection: ConnectionView, sync: { imported: number } | null) => void
}

/**
 * Koppla banken: the one dialog for a new Open Payments connection, a switch
 * from Enable Banking and a renewal. Rendered once per surface next to the
 * `useBankConnectFlow()` that opens it; a new session key gives a clean state.
 * A bank that signs on its own page takes the top window there and comes
 * back to the surface's page, which reopens the dialog in resume mode
 * (use-bank-connect-resume.ts). The flow itself (use-bank-connect-controller.ts,
 * BankConnectSteps.tsx) is shared with the signatory page under /koppla/[token].
 */
export function BankConnectDialog({ flow, onConnected }: BankConnectDialogProps) {
  if (!flow.session) return null
  return <BankConnectDialogInner key={flow.session.key} session={flow.session} onClose={flow.close} onConnected={onConnected} />
}

/**
 * The session doors: the bank calls under /api/bank/open-payments, the
 * payments verification under /api/payments, and the signer on file as the
 * bank feed's overview answers it (the payments availability's signer_known
 * stands in until it lands).
 */
function sessionBackend(): BankConnectBackend {
  return {
    bank: sessionOpenPaymentsApi,
    payments: {
      async probe() {
        const availability = await fetchPaymentsAvailability()
        if (!availability.available) return { offered: false, verification: null, validUntil: null }
        try {
          const verification = await fetchCompanyVerification()
          return { offered: verification.status !== 'valid', verification: verification.status, validUntil: verification.valid_until }
        } catch {
          return { offered: true, verification: 'unknown', validUntil: null }
        }
      },
      fetchVerification: fetchCompanyVerification,
      startVerification: startCompanyVerification,
    },
    watchSignerKnown(onAnswer) {
      let cancelled = false
      let overviewAnswered = false
      fetchOpenPaymentsOverview()
        .then((overview) => {
          if (cancelled) return
          overviewAnswered = true
          onAnswer(overview.signer_known)
        })
        .catch(() => {
          // The payments availability's answer stands.
        })
      fetchPaymentsAvailability()
        .then((availability) => {
          if (!cancelled && !overviewAnswered) onAnswer(availability.signer_known)
        })
        .catch(() => {})
      return () => {
        cancelled = true
      }
    },
  }
}

function BankConnectDialogInner({ session, onClose, onConnected }: { session: BankConnectSession; onClose: () => void; onConnected?: BankConnectDialogProps['onConnected'] }) {
  const t = useTranslations('bank_connect')
  const { toast } = useToast()
  const company = useCompanyOptional()?.company ?? null
  const availability = useOpenPaymentsAvailability()
  const [confirmClose, setConfirmClose] = useState(false)
  const backend = useMemo(() => sessionBackend(), [])
  const banks = availability.banks
  const banksFailed = availability.status === 'unavailable'
  const controller = useBankConnectController({
    session,
    backend,
    banks,
    banksFailed,
    onConnected: (connection, sync) => {
      // The connection is live: tell the surfaces that show bank state, once.
      notifyBankSyncUpdated()
      void invalidateReferenceData(['ref:cash-accounts', 'ref:accounts'])
      onConnected?.(connection, sync)
    },
  })
  const { state } = controller
  const soleTrader = company ? usesPersonnummerAsOrgNumber(company.entity_type) : false

  function sendToSignatory() {
    void controller.openVerification('mail', (url) => {
      window.location.href = verificationMailto({
        subject: t('mail_subject'),
        lines: [t('mail_line_1', { company: company?.name ?? '' }), t('mail_line_2')],
        url,
      })
    })
  }

  async function copyReminder() {
    if (!state.connectionId) return
    try {
      await navigator.clipboard.writeText(resumeFlowUrl(window.location.origin, state.connectionId))
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

  async function abandon() {
    await controller.abandon()
    onClose()
  }

  const position = flowPosition(state)
  const titleBank = controller.bankName
  const titleMark = flowShowsBankMark(state, titleBank)
  const title = flowTitle(state, titleBank, t)
  const cancelButton = (
    <Button variant="secondary" onClick={requestClose}>
      {t('cancel')}
    </Button>
  )

  return (
    <>
      <Dialog open onOpenChange={(next) => !next && requestClose()}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            {position && (
              <p className="text-[12.5px] tabular-nums text-muted-foreground" data-ph-unmask="">
                {t('step_of', { n: position.n, total: position.total })}
              </p>
            )}
            <div className="flex items-center justify-center gap-2 sm:justify-start">
              {titleMark && <BankMark bankName={titleBank} size={24} />}
              <DialogTitle data-ph-mask={titleMark ? '' : undefined}>{title}</DialogTitle>
              {state.step !== 'done' && (
                <HelpPopover className="shrink-0">
                  <FlowHelp controller={controller} />
                </HelpPopover>
              )}
            </div>
            <DialogDescription className="sr-only">{title}</DialogDescription>
          </DialogHeader>

          <FlowSteps
            controller={controller}
            session={session}
            banks={banks}
            banksFailed={banksFailed}
            soleTrader={soleTrader}
            closeButton={cancelButton}
            onClose={onClose}
            onCopyReminder={copyReminder}
            onSendToSignatory={sendToSignatory}
          />
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
