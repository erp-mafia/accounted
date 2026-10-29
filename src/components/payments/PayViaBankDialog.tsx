'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { creditorNameMatches } from '@/lib/payments/creditor-name-match'
import { formatCurrency, formatDate } from '@/lib/utils'
import { BankIdSigningFlow, type SigningFlowStage } from './BankIdSigningFlow'
import { RequestSigningLinkButton, RequestSigningLinkPanel } from './RequestSigningLinkDialog'
import { BankPaymentsAllowanceLine } from './BankPaymentsAllowance'
import { BankPaymentAccountGate, useBankPaymentDialog } from './bank-payment-dialog'
import { PaymentAccountPicker, rememberPaymentAccount } from './PaymentAccountPicker'
import { DocumentCheckLine, InvoiceDocumentButton, InvoiceDocumentSheet, PaymentBesideDocument, paymentFromPreviewLine } from './InvoiceDocumentPreview'
import { earliestExecutionDateIso } from '@/lib/payments/bank-days'
import {
  approvePaymentOrders,
  lookupCreditorName,
  orderGiroForLookup,
  payeeLabel,
  PaymentsClientError,
  preparePaymentOrders,
  previewPaymentOrders,
  type CreditorLookupResult,
  type PaymentOrder,
  type PreparedPreview,
  remainingBankPayments,
} from './payments-client'

/**
 * Betala via banken, from the supplier invoice list or one invoice:
 *   preview: one screen. The account to pay from (remembered, shown as a
 *            choice only when there are several), the payment date (per
 *            invoice unless the person changes it), one line per invoice with
 *            the payee it goes to, and what cannot be paid and why. Nothing is
 *            written: the lines are the server's dry run.
 *   confirm: when an invoice states another account than the supplier
 *            card: the person confirms each such payee before signing. Also,
 *            with the Bankgiro Lookup switched on (OPENPAYMENTS_BANKGIRO_LOOKUP
 *            on the server), for every first payment to a bankgiro or
 *            plusgiro: the name Bankgirot has registered for the number is
 *            shown under the payee (quiet when it is the supplier's name,
 *            an attention line when it differs or the OCR is refused), and
 *            the person signs with that in view. Advice, never a gate.
 *   sign:    one button creates the drafts, approves them and starts the
 *            BankID signing at once. The signature is the approval: a person
 *            who may approve and sign does both in one step. Orders left
 *            unsigned stay under Betalningar, Att signera, for another signer.
 * A draft of the same invoice nobody approved is replaced by the server, so a
 * second attempt never fails on the first one's leftovers.
 */

/** request: Be någon annan signera; the approved orders get a signing link instead of a BankID here. */
type Phase = 'preview' | 'confirm' | 'sign' | 'request'

interface PayViaBankDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoiceIds: string[]
  /** Supplier and invoice number per invoice id, for the rows and the skipped list. */
  invoiceLabelById?: ReadonlyMap<string, string>
  /** Called when the dialog closes after anything changed (drafts made, approved or sent to the bank). */
  onDone: () => void
}

type Skipped = Array<{ supplier_invoice_id: string; reason: string }>

/** Orders to a giro the company never paid, or whose account differs from the card: the ones Bankgirot's name is asked for. */
function unconfirmedGiroOrders(list: PaymentOrder[]): PaymentOrder[] {
  return list.filter((o) => (o.payee_check === 'new' || o.payee_check === 'changed') && orderGiroForLookup(o) !== null)
}

/**
 * The registered name per order id, asked in parallel. A lookup that fails
 * in the browser is left out: the payment goes on without the note.
 */
async function lookupRegisteredNames(list: PaymentOrder[]): Promise<Map<string, CreditorLookupResult>> {
  const answers = await Promise.all(
    unconfirmedGiroOrders(list).map(async (o) => {
      const giro = orderGiroForLookup(o)
      if (!giro) return null
      try {
        const result = await lookupCreditorName({
          ...giro,
          ocr: o.reference_type === 'ocr' ? o.reference : null,
          invoiceRef: o.reference_type === 'message' ? o.reference : null,
        })
        return [o.id, result] as const
      } catch {
        return null
      }
    }),
  )
  return new Map(answers.filter((a): a is readonly [string, CreditorLookupResult] => a !== null))
}

function skippedFromError(error: unknown): Skipped | null {
  if (!(error instanceof PaymentsClientError) || error.code !== 'PAYMENT_ORDERS_INELIGIBLE') return null
  const body = error.body as { error?: { details?: { skipped?: unknown } } } | null
  const skipped = body?.error?.details?.skipped
  return Array.isArray(skipped) ? (skipped as Skipped) : null
}

export default function PayViaBankDialog({ open, onOpenChange, invoiceIds, invoiceLabelById, onDone }: PayViaBankDialogProps) {
  const t = useTranslations('bank_payments')
  const { availability, usage, raiseIncluded, accountId, setAccountId, payableAccounts, account, unsupportedBank, verificationLine, fail } =
    useBankPaymentDialog(open)

  const [phase, setPhase] = useState<Phase>('preview')
  const [executionDate, setExecutionDate] = useState('')
  const [editingDate, setEditingDate] = useState(false)
  const [preview, setPreview] = useState<PreparedPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [nothingToPay, setNothingToPay] = useState<Skipped | null>(null)
  const [orders, setOrders] = useState<PaymentOrder[]>([])
  const [lookups, setLookups] = useState<Map<string, CreditorLookupResult>>(new Map())
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [signingStage, setSigningStage] = useState<SigningFlowStage>('method')
  /** What follows the approval: a BankID here (sign), or a link for someone else (request). */
  const [intent, setIntent] = useState<'sign' | 'request'>('sign')
  /** The invoice whose document is open in the side sheet, when several are paid. */
  const [documentKey, setDocumentKey] = useState<string | null>(null)
  const changed = useRef(false)

  // The preview follows the account and the date: a dry run on the server,
  // every rule, nothing written.
  const invoiceKey = invoiceIds.join(',')
  useEffect(() => {
    if (!open || !accountId || phase !== 'preview') return
    let cancelled = false
    setPreviewing(true)
    previewPaymentOrders({ supplierInvoiceIds: invoiceIds, cashAccountId: accountId, executionDate: executionDate || null })
      .then((data) => {
        if (cancelled) return
        setPreview(data)
        setNothingToPay(null)
      })
      .catch((error) => {
        if (cancelled) return
        setPreview(null)
        const skipped = skippedFromError(error)
        if (skipped) setNothingToPay(skipped)
        else fail(t('preview_failed_title'), error)
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId, executionDate, invoiceKey, phase])

  const lines = preview?.lines ?? []
  // More invoices than the month's cap still takes: nothing is prepared or
  // approved that could not go to the bank this month.
  const overCap = usage !== null && lines.length > remainingBankPayments(usage)
  // Each line beside what its invoice document states (the dry run carries it).
  const payments = useMemo(
    () => (preview?.lines ?? []).map((line) => paymentFromPreviewLine(line, invoiceLabelById?.get(line.supplier_invoice_id))),
    [preview, invoiceLabelById],
  )
  const paymentByKey = useMemo(() => new Map(payments.map((p) => [p.key, p])), [payments])
  // One invoice: the document beside the payment, so the dialog widens for it.
  const single = phase === 'preview' && lines.length === 1 && payments.length === 1
  const skipped = nothingToPay ?? preview?.skipped ?? []
  const toConfirm = useMemo(() => orders.filter((o) => o.payee_check === 'changed'), [orders])
  const allConfirmed = toConfirm.every((o) => o.supplier_invoice_id && confirmed.has(o.supplier_invoice_id))
  // The lookup is on when the server answered any order with enabled: the
  // first payments to a giro are then reviewed with Bankgirot's name in view.
  const lookupOn = useMemo(() => [...lookups.values()].some((l) => l.enabled), [lookups])
  const toReview = useMemo(
    () => orders.filter((o) => o.payee_check === 'changed' || (lookupOn && o.payee_check === 'new' && orderGiroForLookup(o) !== null)),
    [orders, lookupOn],
  )

  async function approveAndSign(list: PaymentOrder[], confirmedInvoiceIds: string[], next: 'sign' | 'request' = intent) {
    await approvePaymentOrders({ orderIds: list.map((o) => o.id), confirmedPayeeInvoiceIds: confirmedInvoiceIds })
    setOrders(list.map((o) => ({ ...o, status: 'approved' as const })))
    setPhase(next)
  }

  /** The first payment to an account the company never paid: the person saw it on the line and signs it. */
  function firstTimePayees(list: PaymentOrder[]): string[] {
    return list.filter((o) => o.payee_check === 'new' && o.supplier_invoice_id).map((o) => o.supplier_invoice_id as string)
  }

  async function signNow(next: 'sign' | 'request' = 'sign') {
    if (!preview || lines.length === 0) return
    setIntent(next)
    setBusy(true)
    try {
      rememberPaymentAccount(accountId)
      const result = await preparePaymentOrders({ supplierInvoiceIds: invoiceIds, cashAccountId: accountId, executionDate: executionDate || null })
      changed.current = true
      setOrders(result.orders)
      const names = await lookupRegisteredNames(result.orders)
      setLookups(names)
      const nameReview = [...names.values()].some((l) => l.enabled)
      if (result.orders.some((o) => o.payee_check === 'changed') || nameReview) {
        setPhase('confirm')
        return
      }
      await approveAndSign(result.orders, firstTimePayees(result.orders), next)
    } catch (error) {
      const skippedNow = skippedFromError(error)
      if (skippedNow) {
        setPreview(null)
        setNothingToPay(skippedNow)
      } else {
        fail(t('prepare_failed_title'), error)
      }
    } finally {
      setBusy(false)
    }
  }

  async function confirmAndSign() {
    setBusy(true)
    try {
      await approveAndSign(orders, [...new Set([...firstTimePayees(orders), ...confirmed])])
    } catch (error) {
      fail(t('approve_failed_title'), error)
    } finally {
      setBusy(false)
    }
  }

  function close(nextOpen: boolean) {
    if (!nextOpen && changed.current) onDone()
    onOpenChange(nextOpen)
  }

  const closeButton = (
    <Button variant="secondary" onClick={() => close(false)}>
      {phase === 'sign' && signingStage === 'done' ? t('close') : t('cancel')}
    </Button>
  )

  const title =
    phase === 'sign'
      ? signingStage === 'done'
        ? t('title_done')
        : t('title_sign')
      : phase === 'confirm'
        ? t('title_confirm')
        : t('title')

  /** What Bankgirot says about the payee's giro: one quiet line, or an attention line when it does not read as the supplier. */
  function registeredNameLines(order: PaymentOrder) {
    const lookup = lookups.get(order.id)
    const giro = orderGiroForLookup(order)
    if (!lookup || !lookup.enabled || !giro) return null
    if (!lookup.available || !lookup.creditor_name) {
      return (
        <p className="text-[12.5px] text-muted-foreground">
          {lookup.reason === 'not_found' ? t('registered_name_not_found') : t('registered_name_unavailable')}
        </p>
      )
    }
    const name = lookup.creditor_name
    return (
      <>
        {creditorNameMatches(name, order.payee_name) ? (
          <p className="text-[12.5px] text-muted-foreground">{t(giro.type === 'bankgiro' ? 'registered_name_bankgiro' : 'registered_name_plusgiro', { name })}</p>
        ) : (
          <AttnLine>{t('registered_name_differs', { name, supplier: order.payee_name })}</AttnLine>
        )}
        {lookup.ocr_valid === false && <AttnLine>{t('ocr_not_accepted')}</AttnLine>}
      </>
    )
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={single ? 'max-w-4xl' : 'max-w-2xl'}>
        {phase !== 'request' && (
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{t('title')}</DialogDescription>
          </DialogHeader>
        )}

        {phase === 'preview' && (
          <div className="space-y-4">
            <BankPaymentAccountGate availability={availability} payableAccounts={payableAccounts} unsupportedBank={unsupportedBank}>
              {verificationLine}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
                <PaymentAccountPicker accounts={payableAccounts} accountId={accountId} onChange={setAccountId} />
                <div className="flex items-center gap-2">
                  {editingDate ? (
                    <>
                      <Input
                        type="date"
                        aria-label={t('date_label')}
                        min={earliestExecutionDateIso(new Date().toLocaleDateString('sv-SE'))}
                        value={executionDate}
                        onChange={(e) => setExecutionDate(e.target.value)}
                        className="h-8 w-[160px] tabular-nums"
                      />
                      <button
                        type="button"
                        className="text-muted-foreground underline underline-offset-2"
                        onClick={() => {
                          setExecutionDate('')
                          setEditingDate(false)
                        }}
                      >
                        {t('reset_date')}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground">
                        {executionDate ? t('date_chosen', { date: formatDate(executionDate) }) : t('date_default')}
                      </span>
                      <button type="button" className="underline underline-offset-2" onClick={() => setEditingDate(true)}>
                        {t('change_date')}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {previewing && !preview ? (
                <div className="space-y-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : single ? (
                <div className={previewing ? 'opacity-60' : undefined}>
                  <PaymentBesideDocument
                    payment={payments[0]}
                    payeeExtra={
                      (lines[0].alternative_payee || lines[0].warnings.includes('unattested')) && (
                        <span className="mt-1 flex flex-wrap justify-end gap-2">
                          {lines[0].alternative_payee && (
                            <Badge variant="warning" className="font-normal" title={t('payee_changed_detail', { alternative: lines[0].alternative_payee })}>
                              {t('payee_changed')}
                            </Badge>
                          )}
                          {lines[0].warnings.includes('unattested') && (
                            <Badge variant="outline" className="font-normal">
                              {t('unattested')}
                            </Badge>
                          )}
                        </span>
                      )
                    }
                    dateExtra={
                      lines[0].date_moved_from && (
                        <span className="block text-[11px] text-muted-foreground">{t('date_moved', { from: formatDate(lines[0].date_moved_from) })}</span>
                      )
                    }
                  />
                </div>
              ) : lines.length > 0 ? (
                <div className={previewing ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}>
                  <table className="w-full border-collapse text-[13px]">
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">{t('th_supplier')}</th>
                        <th className="py-2 pr-3 font-medium">{t('th_payee')}</th>
                        <th className="py-2 pr-3 font-medium">{t('th_date')}</th>
                        <th className="py-2 text-right font-medium">{t('th_amount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line) => {
                        const label = invoiceLabelById?.get(line.supplier_invoice_id) ?? line.supplier_invoice_number
                        const payment = paymentByKey.get(line.supplier_invoice_id)
                        return (
                          <tr key={line.supplier_invoice_id} className="border-b border-border align-middle">
                            <td className="w-1/3 max-w-0 py-2 pr-3">
                              <div className="flex items-center gap-1">
                                <div className="min-w-0 flex-1">
                                  <span className="block truncate">{line.supplier_name}</span>
                                  <span className="block truncate text-[11px] text-muted-foreground">{label}</span>
                                </div>
                                {payment && <InvoiceDocumentButton payment={payment} onOpen={setDocumentKey} />}
                              </div>
                            </td>
                            <td className="whitespace-nowrap py-2 pr-3 tabular-nums">
                              <span>{line.payee.label}</span>
                              {line.alternative_payee && (
                                <Badge
                                  variant="warning"
                                  className="ml-2 font-normal"
                                  title={t('payee_changed_detail', { alternative: line.alternative_payee })}
                                >
                                  {t('payee_changed')}
                                </Badge>
                              )}
                              {line.warnings.includes('unattested') && (
                                <Badge variant="outline" className="ml-2 font-normal">
                                  {t('unattested')}
                                </Badge>
                              )}
                              <span className="block text-[11px] text-muted-foreground">
                                {line.reference.type === 'ocr' ? `OCR ${line.reference.value}` : line.reference.value}
                              </span>
                              {payment && <DocumentCheckLine payment={payment} className="whitespace-normal" />}
                            </td>
                            <td className="whitespace-nowrap py-2 pr-3 tabular-nums">
                              {formatDate(line.requested_execution_date)}
                              {line.date_moved_from && (
                                <span className="block text-[11px] text-muted-foreground">{t('date_moved', { from: formatDate(line.date_moved_from) })}</span>
                              )}
                            </td>
                            <td className="whitespace-nowrap py-2 text-right tabular-nums">{formatCurrency(Number(line.amount), line.currency)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                    {lines.length > 1 && (
                      <tfoot>
                        <tr>
                          <td colSpan={3} className="py-2 pr-3 text-muted-foreground">
                            {t('total')}
                          </td>
                          <td className="py-2 text-right font-medium tabular-nums">{formatCurrency(preview?.total_amount ?? 0, preview?.currency ?? 'SEK')}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              ) : nothingToPay ? (
                <AttnLine>{t('nothing_to_pay')}</AttnLine>
              ) : null}

              {skipped.length > 0 && (
                <div className="space-y-1 text-[12.5px] text-muted-foreground">
                  {lines.length > 0 && <p>{t('skipped_title', { count: skipped.length })}</p>}
                  <ul className="space-y-1">
                    {skipped.map((s) => (
                      <li key={s.supplier_invoice_id}>
                        {invoiceLabelById?.get(s.supplier_invoice_id) ?? s.supplier_invoice_id}:{' '}
                        {t.has(`skip_${s.reason}`) ? t(`skip_${s.reason}`) : s.reason}
                        {s.reason === 'already_in_payment' && (
                          <>
                            {' '}
                            <Link href="/payments" className="underline underline-offset-2">
                              {t('open_payments_page')}
                            </Link>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <InvoiceDocumentSheet payment={documentKey ? (paymentByKey.get(documentKey) ?? null) : null} onClose={() => setDocumentKey(null)} />

              {preview && preview.replaces_drafts > 0 && (
                <p className="text-[12.5px] text-muted-foreground">{t('replaces_drafts', { count: preview.replaces_drafts })}</p>
              )}
              {lines.length > 0 && <p className="text-[12.5px] text-muted-foreground">{t('sign_hint')}</p>}
              {lines.length > 0 && <BankPaymentsAllowanceLine usage={usage} count={lines.length} canRequest onIncluded={raiseIncluded} />}
            </BankPaymentAccountGate>
            <DialogFooter>
              {closeButton}
              {lines.length > 0 && (
                <RequestSigningLinkButton onClick={() => signNow('request')} loading={busy && intent === 'request'} disabled={busy || previewing || !accountId || overCap} />
              )}
              {lines.length > 0 && (
                <Button onClick={() => signNow('sign')} loading={busy && intent === 'sign'} disabled={busy || previewing || !accountId || overCap}>
                  {t('sign_now', { count: lines.length })}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}

        {phase === 'confirm' && (
          <div className="space-y-4">
            <p className="text-[12.5px] text-muted-foreground">{t('confirm_payees_intro')}</p>
            {toReview.map((order) => {
              const invoiceId = order.supplier_invoice_id as string
              return (
                <div key={order.id} className="space-y-1">
                  {order.payee_check === 'changed' ? (
                    <label className="flex items-center gap-2 text-[13px]">
                      <Checkbox
                        className="border-foreground"
                        checked={confirmed.has(invoiceId)}
                        onCheckedChange={(v) =>
                          setConfirmed((prev) => {
                            const next = new Set(prev)
                            if (v === true) next.add(invoiceId)
                            else next.delete(invoiceId)
                            return next
                          })
                        }
                      />
                      <span>{t('confirm_payee_row', { supplier: order.payee_name, payee: payeeLabel(order) })}</span>
                    </label>
                  ) : (
                    <p className="text-[13px]">{t('new_payee_row', { supplier: order.payee_name, payee: payeeLabel(order) })}</p>
                  )}
                  <div className="pl-6">{registeredNameLines(order)}</div>
                </div>
              )
            })}
            <DialogFooter>
              {closeButton}
              {intent === 'request' ? (
                <RequestSigningLinkButton variant="default" label="approve_and_request" onClick={confirmAndSign} loading={busy} disabled={busy || !allConfirmed} />
              ) : (
                <Button onClick={confirmAndSign} loading={busy} disabled={busy || !allConfirmed}>
                  {t('confirm_and_sign')}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}

        {phase === 'request' && (
          <RequestSigningLinkPanel
            orders={orders.map((o) => ({ id: o.id, payee_name: o.payee_name, amount: Number(o.amount), currency: o.currency }))}
            onClose={() => close(false)}
            withHeader
          />
        )}

        {phase === 'sign' && availability && (
          <BankIdSigningFlow
            orders={orders.map((o) => ({ id: o.id, payee_name: o.payee_name, amount: Number(o.amount), currency: o.currency }))}
            signerKnown={availability.signer_known}
            bankName={account?.bank_name ?? null}
            closeButton={closeButton}
            onStageChange={setSigningStage}
            autoStart
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
