'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { BuildingLibraryIcon, PlusIcon } from '@/components/icons'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Button } from '@/components/ui/button'
import { BankMark } from '@/components/banks/BankMark'
import { BulkSelectionBar } from '@/components/ui/bulk-selection-bar'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, HOVER_REVEAL_CLASS, CHECKBOX_REVEAL_CLASS } from '@/components/ui/dry-table'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useBulkSelection } from '@/lib/hooks/use-bulk-selection'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'
import { parsePaymentSigningReturn, stripPaymentSigningReturn, type PaymentSigningReturn } from '@/lib/payments/orders/return-url'
import { ApprovePaymentOrdersDialog } from './ApprovePaymentOrdersDialog'
import { ResolvePaymentOrderDialog } from './ResolvePaymentOrderDialog'
import { SignPaymentOrdersDialog } from './SignPaymentOrdersDialog'
import { RequestSigningLinkButton, RequestSigningLinkDialog, SigningLinkRowNote } from './RequestSigningLinkDialog'
import { listOpenSigningLinks, openLinksByOrder, type OpenSigningLink } from './signing-links-client'
import {
  bankSilentSince,
  canCancel,
  needsResolution,
  PAYMENT_ORDER_SECTIONS,
  PAYMENT_ORDER_STATUS_BADGE,
  sectionOf,
  signAgainOrders,
  type PaymentOrderSection,
} from './payment-order-status'
import {
  providerCodeText,
  cancelPaymentOrder,
  fetchCompanyVerification,
  fetchPaymentsAvailability,
  isReleasableUnsignedRefusal,
  listPaymentOrders,
  orderInvoiceLabel,
  payeeLabel,
  PaymentsClientError,
  startCompanyVerification,
  unapprovePaymentOrders,
  type CompanyVerification,
  type PaymentOrder,
  type PaymentsAvailability,
} from './payments-client'
import { VerificationStateText } from './VerificationStateText'
import { fetchPayeeAlertMarkers, type PayeeAlertMarker } from './payee-change-client'
import { FORM_OUT_STATES } from '@/lib/payments/orders/verification-state'
import { verificationStep } from '@/lib/payments/orders/readiness'
import { startPollLoop } from '@/components/bank-feed/poll-loop'

/** The provider's form is filled in by hand: a quarter minute between looks while one is open. */
const VERIFICATION_POLL_MS = 15_000

// Ny betalning till Skatteverket: the skattekonto payment, loaded when opened.
const PaySkattekontoViaBankDialog = dynamic(() => import('./PaySkattekontoViaBankDialog'), { loading: DialogLoadingSkeleton })

/**
 * Betalningar: every bank payment the company asked its bank to make, by where
 * it stands, plus the way to the payment files for companies that pay by file.
 * Payments are prepared from Leverantörsfakturor (Betala via banken); here they
 * are approved (Godkänn), signed with one BankID per basket (Signera), followed,
 * cancelled, and the rare one the bank could not settle is resolved by a person.
 */
export function PaymentOrdersPage() {
  const t = useTranslations('payments_page')
  const tCommon = useTranslations('common')
  const tStatus = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { dialogProps, confirm } = useDestructiveConfirm()
  // Its own dialog: it opens while the cancel dialog is still closing.
  const { dialogProps: releaseDialogProps, confirm: confirmRelease } = useDestructiveConfirm()

  const [availability, setAvailability] = useState<PaymentsAvailability | null>(null)
  /**
   * The last availability read failed. Kept apart from a real "not
   * available": a failed read must not tell a company with bank payments on
   * that they are off. The availability already on screen stays.
   */
  const [availabilityFailed, setAvailabilityFailed] = useState(false)
  /** Where the company's verification at the provider stands; null until read, or when payments are not available. */
  const [verification, setVerification] = useState<CompanyVerification | null>(null)
  /** The form link opened from this page in this sitting, so it can be opened again. */
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null)
  const [verificationBusy, setVerificationBusy] = useState(false)
  const [payingSkattekonto, setPayingSkattekonto] = useState(false)
  const [orders, setOrders] = useState<PaymentOrder[] | null>(null)
  /** The last read of the orders failed: with none on screen the page says so in their place; orders on screen stay. */
  const [ordersFailed, setOrdersFailed] = useState(false)
  const [approving, setApproving] = useState<PaymentOrder[] | null>(null)
  const [signing, setSigning] = useState<PaymentOrder[] | null>(null)
  /** Set when the signing dialog was reopened by a return from the bank's own page. */
  const [resume, setResume] = useState<PaymentSigningReturn | null>(null)
  /** Signera igen: the signing whose payments wait unsigned at the bank, restarted instead of a new one. */
  const [signAgainBatch, setSignAgainBatch] = useState<string | null>(null)
  /** Kontrasignera: the signing the bank holds for another signatory, who signs it here. */
  const [secondSignatureBatch, setSecondSignatureBatch] = useState<string | null>(null)
  const [resolving, setResolving] = useState<PaymentOrder | null>(null)
  /** Be någon annan signera: the approved orders a signing link is being made for. */
  const [requesting, setRequesting] = useState<PaymentOrder[] | null>(null)
  /** Open signing links, so an approved row says whose signature it waits for. */
  const [openLinks, setOpenLinks] = useState<OpenSigningLink[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  /** Invoices whose stated bank details nobody approved (or a person rejected): marked on their payment rows. */
  const [payeeMarkers, setPayeeMarkers] = useState<Map<string, PayeeAlertMarker>>(new Map())
  useEffect(() => {
    fetchPayeeAlertMarkers().then(setPayeeMarkers, () => setPayeeMarkers(new Map()))
  }, [])

  const fail = useCallback(
    (title: string, error: unknown) => {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title, description: getErrorMessage(body, { locale }), variant: 'destructive' })
    },
    [locale, toast],
  )

  const load = useCallback(async () => {
    const [avail, list, links] = await Promise.allSettled([fetchPaymentsAvailability(), listPaymentOrders(), listOpenSigningLinks()])
    const availabilityValue = avail.status === 'fulfilled' ? avail.value : null
    if (availabilityValue) setAvailability(availabilityValue)
    else setAvailability((current) => current ?? { available: false, reason: null, provider: null, accounts: [], signer_known: false })
    setAvailabilityFailed(avail.status === 'rejected')
    // A failed read keeps the orders already on screen and says so (ordersFailed).
    if (list.status === 'fulfilled') setOrders(list.value)
    else setOrders((current) => current ?? [])
    setOrdersFailed(list.status === 'rejected')
    setOpenLinks(links.status === 'fulfilled' ? links.value : [])
    // The verification rides on the availability (lib/payments/orders/readiness);
    // the line is informational: a failed read leaves it out rather than blocking the page.
    if (availabilityValue) setVerification(availabilityValue.available ? (availabilityValue.verification ?? null) : null)
  }, [])

  // A form is out (opened here, or earlier by someone, or with the
  // firmatecknare): ask the provider every 15 s until it answers valid, so
  // the line turns to "Verifierat till" without a reload.
  const verificationFormOut = verification !== null && FORM_OUT_STATES.has(verification.state)
  useEffect(() => {
    if (!verificationFormOut) return
    return startPollLoop({
      poll: () => fetchCompanyVerification({ refresh: true }),
      onResult: (next) => {
        setVerification(next)
        return FORM_OUT_STATES.has(next.state)
      },
      intervalMs: VERIFICATION_POLL_MS,
    })
  }, [verificationFormOut])

  // Verifiera / Förnya / Skapa ny länk: a fresh 24-hour form in a new tab; the
  // line then says the form is open and the poll above watches for the answer.
  async function startVerification() {
    setVerificationBusy(true)
    try {
      const started = await startCompanyVerification()
      window.open(started.url, '_blank', 'noopener,noreferrer')
      setVerificationUrl(started.url)
      setVerification((current) => ({
        status: current?.status ?? 'unknown',
        valid_until: current?.valid_until ?? null,
        checked_at: current?.checked_at ?? null,
        state: started.state,
        link_expires_at: started.expires_at,
      }))
    } catch (error) {
      fail(t('verification_failed_title'), error)
    } finally {
      setVerificationBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    load().catch(() => {
      if (!cancelled) {
        setAvailability({ available: false, reason: null, provider: null, accounts: [], signer_known: false })
        setOrders([])
      }
    })
    return () => {
      cancelled = true
    }
  }, [load])

  // Back from a bank that signs on its own page (?signing=<batch>&result=ok|error&code=):
  // reopen the signing dialog at its poll for the batch's orders, once, and drop the
  // parameters. The URL carries a flag, never the outcome; the poll tells the truth.
  const searchParams = useSearchParams()
  const returnHandled = useRef(false)
  useEffect(() => {
    if (returnHandled.current || orders === null || availability === null) return
    const parsed = parsePaymentSigningReturn(searchParams)
    if (!parsed) return
    returnHandled.current = true
    const inBatch = orders.filter((o) => o.batch_id === parsed.batchId)
    if (inBatch.length > 0) {
      setResume(parsed)
      setSigning(inBatch)
    }
    window.history.replaceState(window.history.state, '', stripPaymentSigningReturn(window.location.href))
  }, [orders, availability, searchParams])

  // No explicit clear: an order that signing, approval or a resolve moves out
  // of "Att signera" leaves the selection when the reload lands.
  const refresh = useCallback(() => {
    load().catch(() => {
      // The list keeps what it had; the next action reloads it.
    })
  }, [load])

  const available = availability?.available ?? false
  const linkByOrder = useMemo(() => openLinksByOrder(openLinks), [openLinks])
  const bySection = useMemo(() => {
    const groups = new Map<PaymentOrderSection, PaymentOrder[]>()
    for (const section of PAYMENT_ORDER_SECTIONS) groups.set(section, [])
    for (const order of orders ?? []) groups.get(sectionOf(order))!.push(order)
    return groups
  }, [orders])

  const toSign = useMemo(() => bySection.get('to_sign') ?? [], [bySection])
  // The selection holds only orders still waiting to be signed: a reload that
  // moves one on (signed elsewhere, refused) drops it from the bar.
  const toSignIds = useMemo(() => (available && canWrite ? toSign.map((o) => o.id) : []), [toSign, available, canWrite])
  const selection = useBulkSelection(toSignIds)
  const selected = selection.selectedIds
  const selectedOrders = toSign.filter((o) => selected.has(o.id))
  // One signing = one account and one currency (the server refuses a mix):
  // the first selected order decides which others may join.
  const anchor = selectedOrders[0] ?? null
  const selectable = (o: PaymentOrder) => !anchor || (o.cash_account_id === anchor.cash_account_id && o.currency === anchor.currency)
  const selectableToSign = toSign.filter(selectable)
  const allSelected = selectableToSign.length > 0 && selectableToSign.every((o) => selected.has(o.id))

  function toggle(id: string, on: boolean) {
    if (selected.has(id) !== on) selection.toggle(id)
  }

  async function unapprove(order: PaymentOrder) {
    setBusyId(order.id)
    try {
      await unapprovePaymentOrders([order.id])
      refresh()
    } catch (error) {
      fail(t('action_failed_title'), error)
    } finally {
      setBusyId(null)
    }
  }

  // A signing nobody is in left the payments waiting unsigned at the bank
  // (isSignableAgain): the same signing is started again
  // (restartPaymentSigning), over every order of it that still waits.
  function signAgain(order: PaymentOrder) {
    const again = signAgainOrders(order, orders ?? [])
    if (again.length === 0 || !order.batch_id) return
    setSignAgainBatch(order.batch_id)
    setSigning(again)
  }

  // The bank holds the payments for another signatory and takes that
  // signature here (sign_second): the whole signing is signed as them, so
  // the dialog shows every payment of it that waits.
  function signSecond(order: PaymentOrder) {
    if (!order.batch_id) return
    setSecondSignatureBatch(order.batch_id)
    setSigning((orders ?? []).filter((o) => o.batch_id === order.batch_id && o.status === 'awaiting_second_signer'))
  }

  async function cancel(order: PaymentOrder) {
    const atBank = order.status !== 'draft' && order.status !== 'approved'
    let releasable = false
    const label = orderInvoiceLabel(order)
    // Signed, the bank confirming it: a cancel is a recall the bank may want a login for, said as such.
    const confirming = order.bank_confirming === true
    await confirm(
      {
        title: t('cancel_title'),
        description: confirming
          ? t('cancel_bank_confirming_description', { label })
          : atBank
            ? t('cancel_at_bank_description', { label })
            : t('cancel_description', { label }),
        confirmLabel: confirming ? t('cancel_bank_confirming_confirm') : t('cancel_confirm'),
        cancelLabel: t('cancel_keep'),
        variant: 'warning',
      },
      async () => {
        try {
          const result = await cancelPaymentOrder(order.id)
          // A payment the bank rejected when it was read after the cancel is closed too (crm#1699).
          const closed = result.cancelled || result.status === 'rejected' || result.status === 'failed'
          if (!closed) toast({ title: t('cancel_not_confirmed_title'), description: t('cancel_not_confirmed'), variant: 'destructive' })
        } catch (error) {
          // The bank holds the payment unsigned and will not cancel it: offered
          // as a release here once this dialog has closed (crm#1282).
          if (isReleasableUnsignedRefusal(error)) {
            releasable = true
            return
          }
          fail(t('action_failed_title'), error)
          throw error
        }
      },
    )
    // A refused cancel may still have moved the order (an error event, a
    // status the bank reported): reload either way once the dialog closed.
    refresh()
    if (releasable) await releaseUnsigned(order)
  }

  // Släpp betalningen: the bank refused to cancel a payment nobody signed.
  // Nothing is paid without a signature, so the order is let go here and the
  // invoice can be paid again; the bank is asked once more first.
  async function releaseUnsigned(order: PaymentOrder) {
    await confirmRelease(
      {
        title: t('release_unsigned_title'),
        description: t('release_unsigned_description', { label: orderInvoiceLabel(order) }),
        confirmLabel: t('release_unsigned_confirm'),
        cancelLabel: t('cancel_keep'),
        variant: 'warning',
      },
      async () => {
        try {
          const result = await cancelPaymentOrder(order.id, { releaseUnsigned: true })
          if (result.cancelled) toast({ title: t('release_unsigned_done_title'), description: t('release_unsigned_done') })
          else toast({ title: t('cancel_not_confirmed_title'), description: t('cancel_not_confirmed'), variant: 'destructive' })
        } catch (error) {
          fail(t('action_failed_title'), error)
          throw error
        }
      },
    )
    refresh()
  }

  const statusLabel = (status: string) => {
    const key = `status_${status}`
    return tStatus.has(key) ? tStatus(key) : status
  }

  const loading = orders === null || availability === null
  const hasOrders = (orders?.length ?? 0) > 0

  // One line under the header: where the verification stands and the one
  // thing to do about it. Quiet while valid; the attention tone otherwise.
  const verificationLine = (() => {
    if (!available || !verification) return null
    if (verification.state === 'valid') {
      return (
        <p className="text-xs text-muted-foreground">
          <VerificationStateText verification={verification} />
        </p>
      )
    }
    // The step by state (lib/payments/orders/readiness verificationStep): a
    // form this page opened is opened again; one with the firmatecknare is
    // waited for; one opened elsewhere, or none, gets a fresh link.
    const step = verificationStep(verification.state, { formAtHand: verificationUrl !== null })
    const action =
      verificationBusy || step === 'wait' || step === 'none'
        ? undefined
        : step === 'open_form' && verificationUrl
          ? { label: t('verification_open_form'), onClick: () => window.open(verificationUrl, '_blank', 'noopener,noreferrer') }
          : {
              label: step === 'verify' ? t('verification_verify') : step === 'new_link' ? t('verification_new_link') : t('verification_renew'),
              onClick: () => void startVerification(),
            }
    return (
      <AttnLine action={canWrite ? action : undefined}>
        <VerificationStateText verification={verification} />
      </AttnLine>
    )
  })()

  const header = (
    <PageHeader
      title={t('title')}
      help={<HelpPopover>{t('help_body')}</HelpPopover>}
      action={
        available && canWrite ? (
          <Button size="toolbar" variant="outline" onClick={() => setPayingSkattekonto(true)}>
            <PlusIcon className="h-4 w-4" />
            {t('new_skattekonto_payment')}
          </Button>
        ) : undefined
      }
    />
  )

  if (loading) {
    return (
      <div className="space-y-8">
        {header}
        <LateReveal>
          <Skeleton className="mb-3 h-3 w-32" />
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex h-11 items-center gap-8 border-b-hairline">
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="ml-auto h-3.5 w-20" />
              <Skeleton className="h-3.5 w-24" />
            </div>
          ))}
        </LateReveal>
      </div>
    )
  }

  const filesSection = (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">{t('files_heading')}</h2>
      <p className="text-[13px] text-muted-foreground">
        {t('files_body')}{' '}
        <Link href="/supplier-invoices/payment-files" className={QUIET_LINK_CLASS}>
          {t('files_link')}
        </Link>
      </p>
    </section>
  )

  return (
    <div className="space-y-8">
      {header}

      {/* A failed reload takes the place of the verification line: one attention line per page. */}
      {(ordersFailed || availabilityFailed) && hasOrders ? (
        <AttnLine action={{ label: tCommon('retry'), onClick: refresh }}>{tCommon('refresh_failed')}</AttnLine>
      ) : (
        verificationLine
      )}

      {/* Select-all lives on the section head: it picks only the orders that
          can share one signing, which a plain "Markera alla" would not. */}
      <BulkSelectionBar
        selection={selection}
        selectableCount={selectableToSign.length}
        countLabel={t('selected_count', { count: selectedOrders.length })}
        clearLabel={t('clear_selection')}
      >
        <RequestSigningLinkButton onClick={() => setRequesting(selectedOrders)} />
        <Button onClick={() => setSigning(selectedOrders)}>
          {t('sign_selected', { count: selectedOrders.length })}
        </Button>
      </BulkSelectionBar>

      {!available &&
        !hasOrders &&
        !availabilityFailed &&
        (availability?.reason === 'subscription' ? (
          <>
            {filesSection}
            <UpgradeNote>{t('requires_subscription')}</UpgradeNote>
          </>
        ) : (
          // First time, bank payments not open for the company (convention
          // 17): the state says so where the rows would be and gives the way
          // that does work, the payment files. No switch to link to: the plan
          // (the note above) or the installation opens it, not a setting.
          <EmptyState
            icon={BuildingLibraryIcon}
            title={t('not_available')}
            description={t('files_body')}
            actionLabel={t('files_link')}
            actionHref="/supplier-invoices/payment-files"
          />
        ))}

      {!hasOrders && (ordersFailed || availabilityFailed) && <LoadError title={t('load_failed_title')} onRetry={refresh} />}

      {(available || hasOrders) && !hasOrders && !ordersFailed && !availabilityFailed && (
        <EmptyState
          icon={BuildingLibraryIcon}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={t('empty_action')}
          actionHref="/supplier-invoices"
        />
      )}

      {hasOrders &&
        PAYMENT_ORDER_SECTIONS.map((section) => {
          const rows = bySection.get(section) ?? []
          if (rows.length === 0) return null
          const isToSign = section === 'to_sign'
          const isToApprove = section === 'to_approve'
          // Every row under "Att godkänna" is a draft whose status is the
          // section heading itself: no status column there (convention 5).
          const showStatus = !isToApprove
          return (
            <section key={section} className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-sm font-medium text-muted-foreground">
                  {t(`section_${section}`)} <span className="tabular-nums">({rows.length})</span>
                </h2>
                {isToApprove && canWrite && available && (
                  <Button variant="outline" onClick={() => setApproving(rows)}>
                    {t('approve_all', { count: rows.length })}
                  </Button>
                )}
                {isToSign && canWrite && available && selectableToSign.length > 1 && (
                  <button
                    type="button"
                    className={QUIET_LINK_CLASS}
                    onClick={() => (allSelected ? selection.clear() : selection.selectOnly(selectableToSign.map((o) => o.id)))}
                  >
                    {allSelected ? t('clear_selection') : t('select_all', { count: selectableToSign.length })}
                  </button>
                )}
              </div>
              {isToSign && anchor && toSign.some((o) => !selectable(o)) && <AttnLine>{t('mixed_accounts_hint')}</AttnLine>}
              {/* What Väntar på andra firmatecknare asks for, for whoever closed the signing before reading it. */}
              {section === 'in_progress' && rows.some((o) => o.sign_second) && (
                <p className="text-xs text-muted-foreground">{t('second_signer_hint', { count: rows.filter((o) => o.sign_second).length })}</p>
              )}
              <div className="-mx-2 overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      {isToSign && <th className={cn(TH_CLASS, 'w-10')} aria-hidden="true"></th>}
                      <th className={cn(TH_CLASS, 'w-full')}>{t('th_invoice')}</th>
                      <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('th_payee')}</th>
                      <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('th_date')}</th>
                      {showStatus && <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('th_status')}</th>}
                      <th className={cn(TH_CLASS, 'text-right')}>{t('th_amount')}</th>
                      <th className={cn(TH_CLASS, 'hidden w-[200px] sm:table-cell')} aria-hidden="true"></th>
                    </tr>
                  </thead>
                  <tbody className="stagger-enter">
                    {rows.map((order) => {
                      const variant = PAYMENT_ORDER_STATUS_BADGE[order.status]
                      const held = needsResolution(order)
                      const silentSince = bankSilentSince(order)
                      const checked = selected.has(order.id)
                      const canPick = isToSign && canWrite && available && selectable(order)
                      // The payee warning, the status and the row's actions are
                      // written once: on a phone (below sm) their columns hide
                      // and the same content folds under the label.
                      const payeeWarning =
                        order.supplier_invoice_id && payeeMarkers.has(order.supplier_invoice_id) && (order.status === 'draft' || order.status === 'approved') ? (
                          <Badge variant="warning" className="ml-2 font-normal">
                            {tStatus('payee_alert_badge')}
                          </Badge>
                        ) : (
                          (order.payee_check === 'new' || order.payee_check === 'changed') &&
                          order.status === 'draft' && (
                            <Badge variant={order.payee_check === 'changed' ? 'warning' : 'outline'} className="ml-2 font-normal">
                              {tStatus(order.payee_check === 'changed' ? 'payee_changed' : 'payee_new')}
                            </Badge>
                          )
                        )
                      const statusContent = showStatus && (
                        <>
                          {held ? (
                            <Badge variant="warning" className="font-normal">
                              {tStatus('status_outcome_unknown')}
                            </Badge>
                          ) : order.bank_confirming ? (
                            <Badge variant="outline" className="font-normal">
                              {tStatus('status_bank_confirming')}
                            </Badge>
                          ) : variant ? (
                            <Badge variant={variant} className="font-normal">
                              {order.sign_second ? tStatus('status_awaiting_second_signer_here') : statusLabel(order.status)}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">{statusLabel(order.status)}</span>
                          )}
                          {order.status === 'approved' && linkByOrder.has(order.id) && (
                            <SigningLinkRowNote link={linkByOrder.get(order.id)!} canCancel={canWrite} onCancelled={refresh} />
                          )}
                          {order.provider_error_code && (order.status === 'failed' || order.status === 'rejected') && (
                            <span className="ml-2 text-xs text-muted-foreground">{providerCodeText(tStatus, order.provider_error_code) ?? order.provider_error_code}</span>
                          )}
                          {silentSince && (
                            <span className="ml-2 text-xs text-muted-foreground">{tStatus('bank_silent_since', { date: formatDate(silentSince) })}</span>
                          )}
                        </>
                      )
                      const actions = canWrite && (
                        <>
                          {order.status === 'draft' && available && (
                            <button type="button" className={QUIET_LINK_CLASS} onClick={() => setApproving([order])} disabled={busyId !== null}>
                              {t('approve_one')}
                            </button>
                          )}
                          {order.status === 'approved' && available && (
                            <button type="button" className={QUIET_LINK_CLASS} onClick={() => setSigning([order])} disabled={busyId !== null}>
                              {t('sign_one')}
                            </button>
                          )}
                          {order.status === 'approved' && (
                            <button type="button" className={QUIET_LINK_CLASS} onClick={() => unapprove(order)} disabled={busyId !== null}>
                              {t('unapprove')}
                            </button>
                          )}
                          {order.sign_again && available && (
                            <button type="button" className={QUIET_LINK_CLASS} onClick={() => signAgain(order)} disabled={busyId !== null}>
                              {t('sign_again')}
                            </button>
                          )}
                          {order.sign_second && available && (
                            <button type="button" className={QUIET_LINK_CLASS} onClick={() => signSecond(order)} disabled={busyId !== null}>
                              {t('sign_second')}
                            </button>
                          )}
                          {held && available && (
                            <button type="button" className={QUIET_LINK_CLASS} onClick={() => setResolving(order)} disabled={busyId !== null}>
                              {t('resolve')}
                            </button>
                          )}
                          {canCancel(order) && !held && (
                            <button type="button" className={QUIET_LINK_CLASS} onClick={() => cancel(order)} disabled={busyId !== null}>
                              {order.bank_confirming ? t('cancel_bank_confirming_one') : t('cancel_one')}
                            </button>
                          )}
                        </>
                      )
                      return (
                        <tr
                          key={order.id}
                          className={cn('group transition-colors duration-150 hover:bg-secondary/35', checked && 'bg-secondary/40', canPick && 'cursor-pointer')}
                          onClick={
                            canPick
                              ? (e) => {
                                  // The row is the target; its own controls keep their clicks.
                                  if ((e.target as HTMLElement).closest('button, a, input, label, [role="checkbox"]')) return
                                  toggle(order.id, !checked)
                                }
                              : undefined
                          }
                        >
                          {isToSign && (
                            <td className={cn(TD_CLASS, 'w-10 pr-0')}>
                              <span className={cn(CHECKBOX_REVEAL_CLASS, checked && 'opacity-100')}>
                                <Checkbox
                                  className="border-foreground"
                                  checked={checked}
                                  disabled={!canPick}
                                  onCheckedChange={(v) => toggle(order.id, v === true)}
                                  aria-label={t('select_row')}
                                />
                              </span>
                            </td>
                          )}
                          {/* One line (convention 4): the reference is a muted
                              suffix that gives way to the invoice label. */}
                          <td className={cn(TD_CLASS, 'max-w-0')}>
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span className="truncate">{orderInvoiceLabel(order)}</span>
                              {order.reference ? (
                                <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground">{order.reference}</span>
                              ) : null}
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:hidden [&>*]:ml-0">
                              <span className="date-figures">{formatDate(order.requested_execution_date)}</span>
                              {payeeWarning}
                              {statusContent}
                              {canWrite && <span className={cn('flex flex-wrap items-center gap-x-4 gap-y-1', HOVER_REVEAL_CLASS)}>{actions}</span>}
                            </span>
                          </td>
                          <td className={cn(TD_CLASS, 'hidden whitespace-nowrap tabular-nums sm:table-cell')}>
                            {payeeLabel(order)}
                            {payeeWarning}
                          </td>
                          <td className={cn(TD_CLASS, 'hidden whitespace-nowrap date-figures sm:table-cell')}>{formatDate(order.requested_execution_date)}</td>
                          {showStatus && <td className={cn(TD_CLASS, 'hidden whitespace-nowrap sm:table-cell')}>{statusContent}</td>}
                          {/* The paying account sits before the amount on the
                              same line, so the amounts still align right. A
                              phone shows the amount alone. */}
                          <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                            <span className="inline-flex items-center justify-end gap-2">
                              {(() => {
                                const from = availability?.accounts.find((a) => a.id === order.cash_account_id)
                                return from ? (
                                  <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
                                    <BankMark bankName={from.bank_name} size={14} />
                                    {from.ledger_account}
                                  </span>
                                ) : null
                              })()}
                              {formatRowAmount(Number(order.amount), order.currency)}
                            </span>
                          </td>
                          <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right sm:table-cell')}>
                            {canWrite && <span className={cn('flex items-center justify-end gap-4', HOVER_REVEAL_CLASS)}>{actions}</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )
        })}

      {(available || hasOrders) && filesSection}

      <DestructiveConfirmDialog {...dialogProps} />
      <DestructiveConfirmDialog {...releaseDialogProps} />
      {approving && (
        <ApprovePaymentOrdersDialog
          orders={approving}
          onOpenChange={(open) => {
            if (!open) setApproving(null)
          }}
          onApproved={refresh}
          onRequestSignature={available ? setRequesting : undefined}
        />
      )}
      {requesting && (
        <RequestSigningLinkDialog
          orders={requesting.map((o) => ({ id: o.id, payee_name: o.payee_name, amount: Number(o.amount), currency: o.currency }))}
          onOpenChange={(open) => {
            if (!open) setRequesting(null)
          }}
          onIssued={refresh}
        />
      )}
      {signing && availability && (
        <SignPaymentOrdersDialog
          orders={signing}
          signerKnown={availability.signer_known}
          bankName={availability.accounts.find((a) => a.id === signing[0]?.cash_account_id)?.bank_name ?? null}
          resume={resume}
          pendingBatchId={signAgainBatch}
          secondSignatureBatchId={secondSignatureBatch}
          onOpenChange={(open) => {
            if (!open) {
              setSigning(null)
              setResume(null)
              setSignAgainBatch(null)
              setSecondSignatureBatch(null)
            }
          }}
          onDone={refresh}
        />
      )}
      {resolving && (
        <ResolvePaymentOrderDialog
          order={resolving}
          onOpenChange={(open) => {
            if (!open) setResolving(null)
          }}
          onResolved={refresh}
        />
      )}
      {payingSkattekonto && (
        <PaySkattekontoViaBankDialog
          open
          onOpenChange={(open) => {
            if (!open) setPayingSkattekonto(false)
          }}
          onDone={refresh}
        />
      )}
    </div>
  )
}
