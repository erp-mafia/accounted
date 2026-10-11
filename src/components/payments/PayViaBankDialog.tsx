'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import { BankIdSigningFlow, type SigningFlowStage } from './BankIdSigningFlow'
import { BankMark } from '@/components/banks/BankMark'
import {
  approvePaymentOrders,
  fetchPaymentsAvailability,
  payeeLabel,
  PaymentsClientError,
  preparePaymentOrders,
  previewPaymentOrders,
  type PaymentOrder,
  type PaymentsAvailability,
  type PreparedPreview,
} from './payments-client'

/**
 * Betala via banken, from the supplier invoice list or one invoice:
 *   preview: one screen. The account to pay from (remembered, shown as a
 *            choice only when there are several), the payment date (per
 *            invoice unless the person changes it), one line per invoice with
 *            the payee it goes to, and what cannot be paid and why. Nothing is
 *            written: the lines are the server's dry run.
 *   confirm: only when an invoice states another account than the supplier
 *            card: the person confirms each such payee before signing.
 *   sign:    one button creates the drafts, approves them and starts the
 *            BankID signing at once. The signature is the approval: a person
 *            who may approve and sign does both in one step. Orders left
 *            unsigned stay under Betalningar, Att signera, for another signer.
 * A draft of the same invoice nobody approved is replaced by the server, so a
 * second attempt never fails on the first one's leftovers.
 */

type Phase = 'preview' | 'confirm' | 'sign'

/** The account paid from last time, per browser: the one the person most likely wants again. */
const ACCOUNT_MEMORY_KEY = 'accounted.bank_payments.account'

function rememberedAccount(): string | null {
  try {
    return window.localStorage.getItem(ACCOUNT_MEMORY_KEY)
  } catch {
    return null
  }
}

function rememberAccount(id: string) {
  try {
    window.localStorage.setItem(ACCOUNT_MEMORY_KEY, id)
  } catch {
    // Private windows and blocked storage: the default is the first payable account.
  }
}

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

function skippedFromError(error: unknown): Skipped | null {
  if (!(error instanceof PaymentsClientError) || error.code !== 'PAYMENT_ORDERS_INELIGIBLE') return null
  const body = error.body as { error?: { details?: { skipped?: unknown } } } | null
  const skipped = body?.error?.details?.skipped
  return Array.isArray(skipped) ? (skipped as Skipped) : null
}

export default function PayViaBankDialog({ open, onOpenChange, invoiceIds, invoiceLabelById, onDone }: PayViaBankDialogProps) {
  const t = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()

  const [phase, setPhase] = useState<Phase>('preview')
  const [availability, setAvailability] = useState<PaymentsAvailability | null>(null)
  const [accountId, setAccountId] = useState('')
  const [executionDate, setExecutionDate] = useState('')
  const [editingDate, setEditingDate] = useState(false)
  const [preview, setPreview] = useState<PreparedPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [nothingToPay, setNothingToPay] = useState<Skipped | null>(null)
  const [orders, setOrders] = useState<PaymentOrder[]>([])
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [signingStage, setSigningStage] = useState<SigningFlowStage>('method')
  const changed = useRef(false)

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
        const payable = data.accounts.filter((a) => a.payable)
        const remembered = rememberedAccount()
        const pick = payable.find((a) => a.id === remembered) ?? payable[0]
        if (pick) setAccountId(pick.id)
      })
      .catch(() => {
        if (!cancelled) setAvailability({ available: false, reason: null, provider: null, accounts: [], signer_known: false })
      })
    return () => {
      cancelled = true
    }
  }, [open])

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

  const payableAccounts = useMemo(() => availability?.accounts.filter((a) => a.payable) ?? [], [availability])
  const account = payableAccounts.find((a) => a.id === accountId) ?? null
  const lines = preview?.lines ?? []
  const skipped = nothingToPay ?? preview?.skipped ?? []
  const toConfirm = useMemo(() => orders.filter((o) => o.payee_check === 'changed'), [orders])
  const allConfirmed = toConfirm.every((o) => o.supplier_invoice_id && confirmed.has(o.supplier_invoice_id))

  async function approveAndSign(list: PaymentOrder[], confirmedInvoiceIds: string[]) {
    await approvePaymentOrders({ orderIds: list.map((o) => o.id), confirmedPayeeInvoiceIds: confirmedInvoiceIds })
    setOrders(list.map((o) => ({ ...o, status: 'approved' as const })))
    setPhase('sign')
  }

  /** The first payment to an account the company never paid: the person saw it on the line and signs it. */
  function firstTimePayees(list: PaymentOrder[]): string[] {
    return list.filter((o) => o.payee_check === 'new' && o.supplier_invoice_id).map((o) => o.supplier_invoice_id as string)
  }

  async function signNow() {
    if (!preview || lines.length === 0) return
    setBusy(true)
    try {
      rememberAccount(accountId)
      const result = await preparePaymentOrders({ supplierInvoiceIds: invoiceIds, cashAccountId: accountId, executionDate: executionDate || null })
      changed.current = true
      setOrders(result.orders)
      if (result.orders.some((o) => o.payee_check === 'changed')) {
        setPhase('confirm')
        return
      }
      await approveAndSign(result.orders, firstTimePayees(result.orders))
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

  const accountText = account ? `${account.ledger_account} ${account.name ?? ''}`.trim() : ''

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{t('title')}</DialogDescription>
        </DialogHeader>

        {phase === 'preview' && (
          <div className="space-y-4">
            {!availability ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : !availability.available ? (
              <AttnLine>{t('unavailable')}</AttnLine>
            ) : payableAccounts.length === 0 ? (
              <AttnLine>{t('account_none')}</AttnLine>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{t('account_from')}</span>
                    <BankMark bankName={account?.bank_name} />
                    {payableAccounts.length > 1 ? (
                      <select
                        aria-label={t('account_label')}
                        className="h-8 rounded-lg border border-border bg-background px-2 text-[13px]"
                        value={accountId}
                        onChange={(e) => setAccountId(e.target.value)}
                      >
                        {payableAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {`${a.ledger_account} ${a.name ?? ''}`.trim()}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="font-medium">{accountText}</span>
                    )}
                    {account?.iban && <span className="text-muted-foreground tabular-nums">{account.iban}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {editingDate ? (
                      <>
                        <Input
                          type="date"
                          aria-label={t('date_label')}
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
                          return (
                            <tr key={line.supplier_invoice_id} className="border-b border-border align-middle">
                              <td className="w-1/3 max-w-0 py-2 pr-3">
                                <span className="block truncate">{line.supplier_name}</span>
                                <span className="block truncate text-[11px] text-muted-foreground">{label}</span>
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
                              </td>
                              <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{formatDate(line.requested_execution_date)}</td>
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

                {preview && preview.replaces_drafts > 0 && (
                  <p className="text-[12.5px] text-muted-foreground">{t('replaces_drafts', { count: preview.replaces_drafts })}</p>
                )}
                {lines.length > 0 && <p className="text-[12.5px] text-muted-foreground">{t('sign_hint')}</p>}
              </>
            )}
            <DialogFooter>
              {closeButton}
              {lines.length > 0 && (
                <Button onClick={signNow} loading={busy} disabled={busy || previewing || !accountId}>
                  {t('sign_now', { count: lines.length })}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}

        {phase === 'confirm' && (
          <div className="space-y-4">
            <p className="text-[12.5px] text-muted-foreground">{t('confirm_payees_intro')}</p>
            {toConfirm.map((order) => {
              const invoiceId = order.supplier_invoice_id as string
              return (
                <label key={order.id} className="flex items-center gap-2 text-[13px]">
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
              )
            })}
            <DialogFooter>
              {closeButton}
              <Button onClick={confirmAndSign} loading={busy} disabled={busy || !allConfirmed}>
                {t('confirm_and_sign')}
              </Button>
            </DialogFooter>
          </div>
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
