'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { defaultPaymentAccount, PaymentAccountPicker } from './PaymentAccountPicker'
import { primaryPaymentAccount } from './payment-account-choice'
import { PaymentsVerificationLine } from './PaymentsVerificationLine'
import type { SigningFlowStage } from './BankIdSigningFlow'
import {
  fetchBankPaymentsUsage,
  fetchPaymentsAvailability,
  paymentReadinessFor,
  PaymentsClientError,
  withIncludedPayments,
  type BankPaymentsUsage,
  type PayableAccount,
  type PaymentsAvailability,
} from './payments-client'

/**
 * What every Betala via banken dialog reads when it opens (supplier invoices,
 * the skattekonto, a salary run): whether bank payments are on, the payable
 * accounts with one picked (defaultPaymentAccount), this month's payments
 * against the cap, the company's verification where the picked account needs
 * it, and a toast for a failure in the person's language. One place, so the
 * dialogs cannot drift apart on any of it.
 *
 * preferredAccountId is the account the dialog should open on while it can
 * pay: a salary run passes the account its verifikat credits, so the
 * salaries leave from the account the books say they leave from (PH 220).
 * It may arrive after the accounts; until the person picks one in the
 * picker, the default follows it. preferPrimary prefers the company's primary
 * bank account (primaryAccount) instead: the skattekonto payment, whose
 * inbetalning is booked against it.
 */
export function useBankPaymentDialog(
  open: boolean,
  { preferredAccountId = null, preferPrimary = false }: { preferredAccountId?: string | null; preferPrimary?: boolean } = {},
) {
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [availability, setAvailability] = useState<PaymentsAvailability | null>(null)
  /** This month's bank payments against the cap; null until read (informational, the server decides). */
  const [usage, setUsage] = useState<BankPaymentsUsage | null>(null)
  /** The account the person picked in the picker; null while the dialog's default stands. */
  const [picked, setPicked] = useState<string | null>(null)

  const fail = useCallback(
    (title: string, error: unknown) => {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title, description: getErrorMessage(body, { locale }), variant: 'destructive' })
    },
    [locale, toast],
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (cancelled) return
        setAvailability(data)
        // Each opening starts from the default again, as when it was picked here.
        setPicked(null)
        if (data.available) {
          fetchBankPaymentsUsage().then(
            (u) => {
              if (!cancelled) setUsage(u)
            },
            () => {
              // Without the counter the dialog stands; a signing past the cap is refused with the numbers.
            },
          )
        }
      })
      .catch(() => {
        if (!cancelled) setAvailability({ available: false, reason: null, provider: null, accounts: [], signer_known: false })
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const payableAccounts = useMemo(() => availability?.accounts.filter((a) => a.payable) ?? [], [availability])
  /** The company's primary bank account, payable or not; null when none is marked. */
  const primaryAccount = useMemo(() => primaryPaymentAccount(availability?.accounts ?? []), [availability])
  const preferred = preferredAccountId ?? (preferPrimary ? (primaryAccount?.id ?? null) : null)
  const defaultAccountId = useMemo(
    () => defaultPaymentAccount(payableAccounts, preferred)?.id ?? '',
    [payableAccounts, preferred],
  )
  const accountId = picked && payableAccounts.some((a) => a.id === picked) ? picked : defaultAccountId
  const setAccountId = useCallback((id: string) => setPicked(id), [])
  const account = payableAccounts.find((a) => a.id === accountId) ?? null
  // With no payable account, a bank the provider does not pay from is named
  // instead of the IBAN requirement it already meets (crm#1424).
  const unsupportedBank = availability?.accounts.find((a) => a.reason === 'bank_not_supported' && a.bank_name)?.bank_name ?? null
  // The company's verification, where a payment from this account needs it:
  // said on the first screen, with the step that starts it.
  const readiness = availability && account ? paymentReadinessFor(availability, account) : null
  const verificationLine =
    availability?.verification && (readiness === 'verification_needed' || readiness === 'verification_pending') ? (
      <PaymentsVerificationLine verification={availability.verification} />
    ) : null

  // Packs bought from the allowance line raise the cap now: the counter and
  // the over-the-cap gate follow without a second read.
  const raiseIncluded = useCallback((included: number) => setUsage((current) => withIncludedPayments(current, included)), [])
  // An admin accepted the charge above what is included: the cap moved on the server, so read it again.
  const refreshUsage = useCallback(() => {
    fetchBankPaymentsUsage().then(setUsage, () => {
      // Without the counter the dialog stands; the server decides at signing.
    })
  }, [])

  return { availability, usage, raiseIncluded, refreshUsage, accountId, setAccountId, payableAccounts, account, primaryAccount, unsupportedBank, readiness, verificationLine, fail }
}

/**
 * The first screen of a Betala via banken dialog until an account can pay:
 * loading, bank payments switched off, or no payable account (naming a bank
 * the provider does not pay from). The dialog's own content once one can.
 */
export function BankPaymentAccountGate({
  availability,
  payableAccounts,
  unsupportedBank,
  children,
}: {
  availability: PaymentsAvailability | null
  payableAccounts: PayableAccount[]
  unsupportedBank: string | null
  children: ReactNode
}) {
  const t = useTranslations('bank_payments')
  if (!availability) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }
  if (!availability.available) return <AttnLine>{t('unavailable')}</AttnLine>
  if (payableAccounts.length === 0) {
    return <AttnLine>{unsupportedBank ? t('account_none_bank_not_supported', { bank: unsupportedBank }) : t('account_none')}</AttnLine>
  }
  return <>{children}</>
}

/** What useBankPaymentDialog answers: the dialog's account, availability and allowance. */
export type BankPaymentDialogSetup = ReturnType<typeof useBankPaymentDialog>

/**
 * A one-screen Betala via banken dialog (the skattekonto, a salary run): the
 * title by where it stands (title, title_sign, title_done in the dialog's own
 * messages); the preview, behind the account gate, opening with the
 * company's verification and the account to pay from, its footer the close
 * button and the dialog's action; then the BankID signing. Closing tells the
 * page when anything changed (drafts made, approved or sent to the bank) so
 * it reloads.
 */
export function BankPaymentDialogFrame({
  messages,
  open,
  onOpenChange,
  onDone,
  changed,
  phase,
  signingStage,
  setup,
  action,
  signing,
  children,
}: {
  messages: 'skattekonto_bank_payment' | 'salary_bank_payment'
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
  changed: RefObject<boolean>
  phase: 'preview' | 'sign'
  signingStage: SigningFlowStage
  setup: BankPaymentDialogSetup
  /** The preview's primary button, beside the close button. */
  action: ReactNode
  /** The signing step, given the close button for its last screen. */
  signing: (closeButton: ReactNode) => ReactNode
  /** The preview, below the account picker. */
  children: ReactNode
}) {
  const t = useTranslations(messages)
  const tb = useTranslations('bank_payments')
  const done = phase === 'sign' && signingStage === 'done'

  function close(nextOpen: boolean) {
    if (!nextOpen && changed.current) onDone?.()
    onOpenChange(nextOpen)
  }

  const closeButton = (
    <Button variant="secondary" onClick={() => close(false)}>
      {done ? tb('close') : tb('cancel')}
    </Button>
  )

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{phase === 'sign' ? (done ? t('title_done') : t('title_sign')) : t('title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('title')}</DialogDescription>
        </DialogHeader>

        {phase === 'preview' && (
          <div className="space-y-4">
            <BankPaymentAccountGate availability={setup.availability} payableAccounts={setup.payableAccounts} unsupportedBank={setup.unsupportedBank}>
              {setup.verificationLine}
              <div className="text-[13px]">
                <PaymentAccountPicker accounts={setup.payableAccounts} accountId={setup.accountId} onChange={setup.setAccountId} />
              </div>
              {children}
            </BankPaymentAccountGate>
            <DialogFooter>
              {closeButton}
              {action}
            </DialogFooter>
          </div>
        )}

        {phase === 'sign' && signing(closeButton)}
      </DialogContent>
    </Dialog>
  )
}
